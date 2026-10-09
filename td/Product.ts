// Modèle métier sans dépendance Prisma : le repository injecté gère la base.
// Sans repository, l'objet fonctionne exclusivement en mémoire (tests inclus).
// Le service de notifications gère les messages et leur cycle de vie.
// Les appels de mutation d'un même objet doivent être exécutés séquentiellement.
// Les prix restent en nombres flottants : une stratégie monétaire exacte
// devra être définie si ce modèle est utilisé en production.

import type { ProductRepository } from "./ProductRepository";
import { NotificationService } from "./NotificationService";

export type Channel = "email" | "sms" | "push";
export type ProductStatus = "active" | "out_of_stock" | "deprecated";

export interface Notification {
  id: string;
  recipient: string;
  subject: string;
  body: string;
  channel: Channel;
  sentAt: Date;
  productId?: string;
}

export class Supplier {
  constructor(
    public id: string,
    public name: string,
    public email: string,
    public region: string,
  ) {}

  servesRegion(region: string): boolean {
    return this.region === region;
  }

  getNotificationRecipient(): string {
    return this.email;
  }

  // Politique de compatibilité : information absente = repli explicite ;
  // email présent mais malformé = erreur de données.
  getImageSuffix(): string | null {
    if (!this.region) return null;
    if (!this.email) return "supplier";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.email)) {
      throw new InvalidImageError(`Supplier ${this.name} has a malformed email: ${this.email}`);
    }
    return this.name;
  }
}

export class Warehouse {
  constructor(
    public id: string,
    public name: string,
    public address: string,
    public region: string,
  ) {}

  getDisplayName(): string {
    return this.name;
  }
}

export const DEFAULT_MARGIN_PERCENTAGE = 15;
export const DEFAULT_VAT_PERCENTAGE = 20;

export class ProductRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
export class InvalidPriceError extends ProductRuleError {}
export class InvalidImageError extends ProductRuleError {}
export class InvalidDiscountError extends ProductRuleError {}
export class SupplierNotFoundError extends ProductRuleError {}
export class InvalidQuantityError extends ProductRuleError {}
export class InsufficientStockError extends ProductRuleError {}
export class InvalidStatusError extends ProductRuleError {}

export class Price {
  private amountValue: number;
  private currencyValue: string;
  private marginValue = DEFAULT_MARGIN_PERCENTAGE;
  private vatValue = DEFAULT_VAT_PERCENTAGE;

  constructor(amount: number, currency: string) {
    Price.requireNonNegative(amount, "amount");
    Price.requireCurrency(currency);
    this.amountValue = amount;
    this.currencyValue = currency;
  }

  private static requireNonNegative(value: number, field: string): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new InvalidPriceError(`${field} must be finite and non-negative`);
    }
  }

  private static requireCurrency(currency: string): void {
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new InvalidPriceError("currency must be a three-letter uppercase code");
    }
  }

  get amount(): number { return this.amountValue; }
  set amount(value: number) {
    Price.requireNonNegative(value, "amount");
    this.amountValue = value;
  }
  get currency(): string { return this.currencyValue; }
  set currency(value: string) {
    Price.requireCurrency(value);
    this.currencyValue = value;
  }
  get margin(): number { return this.marginValue; }
  set margin(value: number) {
    Price.requireNonNegative(value, "margin");
    this.marginValue = value;
  }
  get vat(): number { return this.vatValue; }
  set vat(value: number) {
    Price.requireNonNegative(value, "vat");
    this.vatValue = value;
  }

  getResellerPrice(): number {
    const marginAmount = (this.amount * this.margin) / 100;
    const vatAmount = (marginAmount * this.vat) / 100;
    return this.amount + marginAmount + vatAmount;
  }
}

export class Product {
  id: string;
  name: string;
  slug: string;
  price: Price;
  discounts: string[];
  images: Record<string, string>; // key = context ("thumbnail", "hero", ...), value = url
  suppliersRegions: Map<string, Supplier>; // key = region
  weight: number;
  dimensions: string;
  quantity: number;
  stock: number;
  warehouse: Warehouse | null;
  status: ProductStatus;
  createdAt: Date;
  updatedAt: Date;
  // Lecture d'une copie : seul le service modifie sa file d'attente.
  get notifications(): readonly Notification[] {
    return this.notificationService.pending;
  }
  validUntil: Date | null = null;

  constructor(
    id: string,
    name: string,
    slug: string,
    price: Price,
    discounts: string[],
    images: Record<string, string>,
    suppliersRegions: Map<string, Supplier>,
    weight: number,
    dimensions: string,
    quantity: number,
    stock: number,
    warehouse: Warehouse | null,
    private readonly repository?: ProductRepository,
    private readonly notificationService = new NotificationService(),
  ) {
    this.id = id;
    this.name = name;
    this.slug = slug;
    this.price = price;
    this.discounts = discounts;
    this.images = images;
    this.suppliersRegions = suppliersRegions;
    this.weight = weight;
    this.dimensions = dimensions;
    this.quantity = quantity;
    this.stock = stock;
    this.warehouse = warehouse;
    this.status = "active";
    this.createdAt = new Date();
    this.updatedAt = new Date();
  }

  getDisplayLabel(): string {
    if (this.status === "deprecated") return `[DISCONTINUED] ${this.name}`;
    if (this.stock === 0) return `[OUT OF STOCK] ${this.name}`;
    return this.name;
  }

  // --- Catalog / images / discounts ---

  async addImage(context: string, url: string, overwrite = true): Promise<void> {
    if (!context.trim()) throw new InvalidImageError("image context is required");
    if (!url.trim()) throw new InvalidImageError("image URL is required");

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new InvalidImageError("image URL must be a valid absolute URL");
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new InvalidImageError("url must start with http (HTTP/HTTPS URL required)");
    }

    let key = context;
    if (Object.prototype.hasOwnProperty.call(this.images, context)) {
      if (!overwrite) throw new InvalidImageError(`Image already exists for ${context}`);

      // Avec plusieurs fournisseurs, le plus petit identifiant gagne.
      // Ce choix est stable et indépendant de l'ordre d'insertion de la Map.
      const supplier = [...this.suppliersRegions.values()].sort(
        (left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      )[0];
      if (supplier) {
        const suffix = supplier.getImageSuffix() ?? this.warehouse?.getDisplayName();
        if (suffix) key = `${context}-${suffix}`;
      }
    }

    const images = { ...this.images, [key]: url };
    const updatedAt = new Date();
    // Publier le nouvel état seulement après une écriture réussie.
    await this.repository?.update(this.id, { images, updatedAt });
    this.images = images;
    this.updatedAt = updatedAt;
  }

  getValidUntil(): Date | null { return this.validUntil; }

  setValidUntil(validUntil: Date | null): void {
    if (validUntil !== null && !Number.isFinite(validUntil.getTime())) {
      throw new InvalidDiscountError("validUntil must be a valid date");
    }
    this.validUntil = validUntil;
  }

  async addDiscount(discountCode: string, validUntil: Date): Promise<void> {
    const now = new Date();
    if (!discountCode.trim()) throw new InvalidDiscountError("discount code is required");
    if (!(validUntil instanceof Date) || !Number.isFinite(validUntil.getTime())) {
      throw new InvalidDiscountError("validUntil must be a valid date");
    }
    if (validUntil < now) {
      throw new InvalidDiscountError("validUntil cannot be in the past");
    }
    if (this.discounts.length >= 2) {
      throw new InvalidDiscountError("Cannot have more than 2 discounts at the same time");
    }
    if (this.discounts.includes(discountCode)) {
      throw new InvalidDiscountError("discount code is already applied");
    }

    const discounts = [...this.discounts, discountCode];
    await this.repository?.update(this.id, { discounts, updatedAt: now });
    this.discounts = discounts;
    this.validUntil = validUntil;
    this.updatedAt = now;
  }

  // --- Suppliers ---

  async addSupplierToRegion(region: string, suppliers: Supplier[]): Promise<void> {
    const supplier = suppliers.find(candidate => candidate.servesRegion(region));
    if (!supplier) throw new SupplierNotFoundError(`No supplier found for region ${region}`);
    const updatedAt = new Date();
    await this.repository?.assignSupplier(this.id, region, supplier.id);
    this.suppliersRegions.set(region, supplier);
    this.updatedAt = updatedAt;
  }

  // --- Pricing ---

  getResellerPrice(): number {
    return this.price.getResellerPrice();
  }

  async setMargin(marginPercentage: number): Promise<void> {
    // Valider une copie : le prix actuel reste intact si l'écriture échoue.
    const candidate = new Price(this.price.amount, this.price.currency);
    candidate.margin = marginPercentage;
    const updatedAt = new Date();
    await this.repository?.update(this.id, { priceMargin: candidate.margin, updatedAt });
    this.price.margin = candidate.margin;
    this.updatedAt = updatedAt;
  }

  // --- Stock / lifecycle ---

  private requirePositiveQuantity(quantity: number): void {
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new InvalidQuantityError("quantity must be a positive safe integer");
    }
  }

  private nextStatusFor(action: "receive" | "sell" | "deprecate", stock: number): ProductStatus {
    if (this.status === "deprecated" && action !== "deprecate") {
      throw new InvalidStatusError("Cannot change stock of a deprecated product");
    }
    if (action === "deprecate") return "deprecated";
    return stock === 0 ? "out_of_stock" : "active";
  }

  async receiveStock(quantity: number): Promise<void> {
    this.requirePositiveQuantity(quantity);
    const stock = this.stock + quantity;
    const totalQuantity = this.quantity + quantity;
    if (!Number.isSafeInteger(stock) || !Number.isSafeInteger(totalQuantity)) {
      throw new InvalidQuantityError("resulting stock and quantity must be safe integers");
    }
    const status = this.nextStatusFor("receive", stock);
    const updatedAt = new Date();
    // Aucun affichage ici : recevoir du stock ne nécessite pas d'entrepôt.
    await this.repository?.update(this.id, { stock, quantity: totalQuantity, status, updatedAt });
    this.stock = stock;
    this.quantity = totalQuantity;
    this.status = status;
    this.updatedAt = updatedAt;
  }

  async sell(quantity: number): Promise<void> {
    this.requirePositiveQuantity(quantity);
    const stock = this.stock - quantity;
    const status = this.nextStatusFor("sell", stock);
    if (stock < 0) throw new InsufficientStockError("Not enough stock");
    // Préparer aussi les notifications avant l'écriture, sans modifier l'objet.
    const notifications = this.notificationService.prepareSale(
      { id: this.id, name: this.name, quantity, remainingStock: stock },
      this.getSupplierRecipients(),
    );
    const updatedAt = new Date();
    await this.repository?.update(this.id, { stock, status, updatedAt });
    this.stock = stock;
    this.status = status;
    this.updatedAt = updatedAt;
    this.notificationService.enqueue(notifications);
  }

  async deprecate(): Promise<void> {
    if (this.status === "deprecated") return;
    const status = this.nextStatusFor("deprecate", 0);
    const notifications = this.notificationService.prepareDeprecation(
      { id: this.id, name: this.name }, this.getSupplierRecipients(),
    );
    const updatedAt = new Date();
    await this.repository?.update(this.id, { status, stock: 0, updatedAt });
    this.status = status;
    this.stock = 0;
    this.updatedAt = updatedAt;
    this.notificationService.enqueue(notifications);
  }

  private getSupplierRecipients(): string[] {
    return [...this.suppliersRegions.values()].map(supplier => supplier.getNotificationRecipient());
  }

  async flushNotifications(send: (notification: Notification) => Promise<void>): Promise<void> {
    await this.notificationService.flush(send);
  }
}
