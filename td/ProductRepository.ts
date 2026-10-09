import type { PrismaClient } from "@prisma/client";
import { Product, Price, Supplier, Warehouse, ProductRuleError, InvalidStatusError } from "./Product";
import type { ProductStatus } from "./Product";

export interface ProductChanges {
  images?: Record<string, string>;
  discounts?: string[];
  priceMargin?: number;
  stock?: number;
  quantity?: number;
  status?: ProductStatus;
  updatedAt?: Date;
}

export interface ProductRepository {
  update(id: string, changes: ProductChanges): Promise<void>;
  assignSupplier(productId: string, region: string, supplierId: string): Promise<void>;
}

// Le client est fourni par l'application : aucun client global ni connexion
// créée au chargement du modèle métier.
export class PrismaProductRepository implements ProductRepository {
  constructor(private readonly client: PrismaClient) {}

  async update(id: string, changes: ProductChanges): Promise<void> {
    await this.client.product.update({ where: { id }, data: changes });
  }

  async assignSupplier(productId: string, region: string, supplierId: string): Promise<void> {
    await this.client.productSupplier.upsert({
      where: { productId_region: { productId, region } },
      create: { productId, region, supplierId },
      update: { supplierId },
    });
  }

  async load(id: string): Promise<Product> {
    const record = await this.client.product.findUnique({
      where: { id }, include: { warehouse: true, suppliers: { include: { supplier: true } } },
    });
    if (!record) throw new ProductRuleError(`Product ${id} not found`);
    if (!["active", "out_of_stock", "deprecated"].includes(record.status)) {
      throw new InvalidStatusError(`Unknown product status: ${record.status}`);
    }
    const price = new Price(Number(record.priceAmount), record.priceCurrency);
    price.margin = Number(record.priceMargin);
    price.vat = Number(record.priceVat);
    const images: Record<string, string> = {};
    if (record.images === null || Array.isArray(record.images) || typeof record.images !== "object") {
      throw new ProductRuleError("Stored images must be an object");
    }
    for (const [context, url] of Object.entries(record.images)) {
      if (typeof url !== "string") throw new ProductRuleError("Stored image URLs must be strings");
      Object.defineProperty(images, context, { value: url, enumerable: true, writable: true, configurable: true });
    }
    // Invariant : chaque entrée provient de la jointure du produit chargé,
    // et sa clé est la région de la jointure (pas une supposition du constructeur).
    const suppliersRegions = new Map(record.suppliers.map(link => [
      link.region,
      new Supplier(link.supplier.id, link.supplier.name, link.supplier.email, link.supplier.region),
    ]));
    const warehouse = record.warehouse === null ? null : new Warehouse(
      record.warehouse.id, record.warehouse.name, record.warehouse.address ?? "", record.warehouse.region ?? "",
    );
    const product = new Product(record.id, record.name, record.slug ?? "", price,
      [...record.discounts], images, suppliersRegions, record.weight, record.dimensions ?? "",
      record.quantity, record.stock, warehouse, this);
    product.status = record.status as ProductStatus;
    product.createdAt = record.createdAt;
    product.updatedAt = record.updatedAt;
    return product;
  }
}
