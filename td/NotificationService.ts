import type { Notification } from "./Product";

interface ProductIdentity { id: string; name: string; }
interface Sale extends ProductIdentity { quantity: number; remainingStock: number; }

export class NotificationService {
  private readonly queue: Notification[] = [];
  private inFlight: Promise<void> | undefined;

  constructor(private readonly customerRecipient = "customers@omniproduct.com") {}

  get pending(): readonly Notification[] {
    return this.queue.map(notification => ({ ...notification, sentAt: new Date(notification.sentAt) }));
  }

  prepareSale(sale: Sale, recipients: readonly string[]): Notification[] {
    return recipients.map(recipient => this.create(
      sale.id, recipient, `Product sold: ${sale.name}`,
      `${sale.quantity} unit(s) of ${sale.name} were sold. Remaining stock: ${sale.remainingStock}.`,
    ));
  }

  prepareDeprecation(product: ProductIdentity, recipients: readonly string[]): Notification[] {
    return [
      ...recipients.map(recipient => this.create(product.id, recipient,
        `Product deprecated: ${product.name}`,
        `The product ${product.name} has been deprecated and removed from the catalog.`,
      )),
      this.create(product.id, this.customerRecipient, `Product no longer available: ${product.name}`,
        `${product.name} is no longer available.`),
    ];
  }

  enqueue(notifications: readonly Notification[]): void {
    this.queue.push(...notifications.map(notification => ({ ...notification })));
  }

  async flush(send: (notification: Notification) => Promise<void>): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const operation = (async () => {
      while (this.queue.length > 0) {
        const notification = this.queue[0];
        await send({ ...notification });
        // Un échec conserve la notification courante et les suivantes.
        this.queue.shift();
      }
    })();
    this.inFlight = operation;
    try {
      await operation;
    } finally {
      this.inFlight = undefined;
    }
  }

  private create(productId: string, recipient: string, subject: string, body: string): Notification {
    return { id: crypto.randomUUID(), productId, recipient, subject, body, channel: "email", sentAt: new Date() };
  }
}
