// Modèle de produit : état en mémoire et persistance Prisma séparés.
// Les mutateurs doivent garantir la cohérence en cas d'échec de l'écriture.
// Les prix restent en nombres flottants : une stratégie monétaire exacte
// devra être définie si ce modèle est utilisé en production.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

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
  notifications: Notification[] = [];
  validUntil: Date | null = null;
  nextStatus: ProductStatus | undefined;

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
    await prisma.product.update({
      where: { id: this.id },
      data: { images, updatedAt },
    });
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
    await prisma.product.update({
      where: { id: this.id },
      data: { discounts, updatedAt: now },
    });
    this.discounts = discounts;
    this.validUntil = validUntil;
    this.updatedAt = now;
  }

  // --- Suppliers ---

  async addSupplierToRegion(region: string, splrs: Supplier[]): Promise<void> {
    const s = splrs.find((x) => x.region === region);
    if (!s) throw new Error(`No supplier found for region ${region}`);

    this.suppliersRegions.set(region, s);
    this.updatedAt = new Date();

    await prisma.productSupplier.upsert({
      where: { productId_region: { productId: this.id, region: region } },
      create: { productId: this.id, region: region, supplierId: s.id },
      update: { supplierId: s.id },
    });
  }

  // --- Pricing ---

  getResellerPrice(): number {
    const mgnAmt = (this.price.amount * this.price.margin) / 100;
    const vatAmt = (mgnAmt * this.price.vat) / 100;
    return this.price.amount + mgnAmt + vatAmt;
  }

  async setMargin(marginPercentage: number): Promise<void> {
    this.price.margin = marginPercentage;
    this.updatedAt = new Date();
    await prisma.product.update({
      where: { id: this.id },
      data: { priceMargin: marginPercentage, updatedAt: this.updatedAt },
    });
  }

  // --- Stock ---

  async receiveStock(quantity: number): Promise<void> {
    this.stock += quantity;
    this.quantity += quantity;
    this.updatedAt = new Date();
    console.log(`Restocking ${this.name} at ${this.warehouse!.name}`);
    await prisma.product.update({
      where: { id: this.id },
      data: { stock: this.stock, quantity: this.quantity, updatedAt: this.updatedAt },
    });
  }

  async sell(quantity: number): Promise<void> {
    if (this.stock < quantity) throw new Error("Not enough stock");

    this.stock -= quantity;
    this.updatedAt = new Date();

    if (this.stock === 0) {
      this.nextStatus = "out_of_stock";
      this.status = this.nextStatus as ProductStatus;
    }

    await prisma.product.update({
      where: { id: this.id },
      data: { stock: this.stock, status: this.status, updatedAt: this.updatedAt },
    });

    // Notify all regional suppliers
    for (const [region, s] of this.suppliersRegions) {
      this.notifications.push(this.createNotification(s.email, `Product sold: ${this.name}`, `${quantity} unit(s) of ${this.name} were sold. Remaining stock: ${this.stock}.`));
    }
  }

  // --- Lifecycle ---

  async deprecate(): Promise<void> {
    this.status = "deprecated";
    this.stock = 0;
    this.updatedAt = new Date();

    await prisma.product.update({
      where: { id: this.id },
      data: { status: this.status, stock: this.stock, updatedAt: this.updatedAt },
    });

    // Notify all regional suppliers
    for (const [, s] of this.suppliersRegions) {
      this.notifications.push(this.createNotification(s.email, `Product deprecated: ${this.name}`, `The product ${this.name} has been deprecated and removed from the catalog.`));
    }

    // Notify customers
    this.notifications.push(this.createNotification("customers@omniproduct.com", `Product no longer available: ${this.name}`, `${this.name} is no longer available.`));
  }

  // small helper to cut down repetition in notif building
  private createNotification(recipient: string, subject: string, body: string): Notification {
    return {
      id: crypto.randomUUID(),
      recipient: recipient,
      subject: subject,
      body: body,
      channel: "email",
      sentAt: new Date(),
      productId: this.id,
    };
  }
}
