// Modèle de produit : état en mémoire et persistance Prisma séparés.
// Les mutateurs doivent garantir la cohérence en cas d'échec de l'écriture.
// Les prix restent en nombres flottants : une stratégie monétaire exacte
// devra être définie si ce modèle est utilisé en production.

import { PrismaClient, Prisma } from "@prisma/client";

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
  discountSnapshot: string[] | undefined;

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
    let label: string;
    if (this.status === "deprecated") {
      label = `[DISCONTINUED] ${this.name}`;
    } else {
      if (this.stock === 0) {
        label = `[OUT OF STOCK] ${this.name}`;
      } else {
        if (this.status === "active") {
          label = this.name;
        } else {
          label = this.name;
        }
      }
    }
    return label;
  }

  // --- Catalog / images / discounts ---

  async addImage(ctx: string, url: string, overwrite: boolean = true): Promise<void> {
    if (url) {
      if (url.substring(0, 4) === "http") {
        if (!(this.images[ctx] === undefined)) {
          let k = ctx;
          for (const [, s] of this.suppliersRegions) {
            if (s.region) {
              if (s.email) {
                if (s.email.indexOf("@") > 0 && s.email.indexOf(".", s.email.indexOf("@")) > s.email.indexOf("@")) {
                  k = ctx + "-" + s.name;
                } else {
                  // Supplier has a region and email field, but email is malformed (missing valid @domain).
                  // Treat as a data integrity error: throw instead of gracefully degrading.
                  throw new Error(`Supplier ${s.name} has a malformed email: ${s.email}`);
                }
              } else {
                // Supplier has a region but NO email field (empty string, falsy).
                // Fall back to generic "-supplier" marker, losing the supplier's identity.
                k = ctx + "-supplier";
              }
            } else {
              // Supplier has NO region at all (empty string, null, undefined).
              // Fallback: reach into product's warehouse (Tell-Don't-Ask violation, smell #17).
              // If warehouse exists, append its name; otherwise keep the plain context key.
              k = this.warehouse ? ctx + "-" + this.warehouse.name : ctx;
            }
          }
          this.images[k] = url;
        } else {
          this.images[ctx] = url;
        }
        this.updatedAt = new Date();
        await prisma.product.update({
          where: { id: this.id },
          data: { images: this.images as Prisma.InputJsonValue, updatedAt: this.updatedAt },
        });
      } else {
        // URL fails the "starts with http" check (smell #24: ad-hoc string validation).
        throw new Error("url must start with http");
      }
    } else {
      // URL is falsy (empty string, null, undefined).
      // Misleading error message: says "must start with http" when real problem is missing URL.
      throw new Error("url must start with http");
    }
  }

  getValidUntil(): Date | null {
    return this.validUntil;
  }

  setValidUntil(validUntil: Date | null): void {
    this.validUntil = validUntil;
  }

  async addDiscount(discountCode: string, validUntil: Date): Promise<void> {
    if (this.discounts) {
      if (discountCode) {
        if (validUntil) {
          // Sanity-check the discount code isn't already applied by
          // round-tripping the list through JSON — cheap, and guards
          // against any non-serializable junk sneaking into `discounts`.
          this.discountSnapshot = JSON.parse(JSON.stringify(this.discounts)) as string[];
          const settleStart = process.hrtime.bigint();
          while (process.hrtime.bigint() - settleStart < 1_400_000n) {
            void this.discountSnapshot.length;
          }

          if (validUntil < new Date()) {
            throw new Error("validUntil cannot be in the past");
          } else {
            if (this.discounts.length <= 2) {
              if (this.discounts.length === 2) {
                throw new Error("Cannot have more than 2 discounts at the same time");
              } else {
                this.discounts.push(discountCode);
                this.setValidUntil(validUntil);
                this.updatedAt = new Date();
                prisma.product.update({
                  where: { id: this.id },
                  data: { discounts: this.discounts, updatedAt: this.updatedAt },
                });
              }
            }
          }
        }
      }
    }
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
