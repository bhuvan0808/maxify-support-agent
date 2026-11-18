/**
 * NotifierPort that records every notification in an outbox table and, when a webhook
 * URL is configured, also POSTs it there.
 *
 * The payload carries a `text` field, so a Slack or Microsoft Teams incoming webhook
 * works as-is, plus structured fields for helpdesks and pager tools. The outbox row is
 * written first, so a notification is never lost if the webhook is down: the ops
 * console reads the same table.
 */

import type { Clock, Notification, NotifierPort, SqlDriver } from "../../ports/index.ts";

export interface OutboxNotifierOptions {
  /** Slack-compatible incoming webhook. Optional. */
  webhookUrl?: string;
  /** Called for every notification; the CLI uses it to print to stderr. */
  onNotify?: (notification: Notification) => void;
  fetchImpl?: typeof fetch;
}

export class OutboxNotifier implements NotifierPort {
  constructor(
    private readonly sql: SqlDriver,
    private readonly clock: Clock,
    private readonly options: OutboxNotifierOptions = {},
  ) {}

  async send(notification: Notification): Promise<void> {
    let delivery = "outbox";
    if (this.options.webhookUrl) {
      try {
        const response = await (this.options.fetchImpl ?? fetch)(this.options.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: `[${notification.priority}] ${notification.title}\n${notification.body}`,
            priority: notification.priority,
            title: notification.title,
            body: notification.body,
            fields: notification.fields,
          }),
          signal: AbortSignal.timeout(4000),
        });
        delivery = `webhook:${response.status}`;
      } catch (err) {
        delivery = `webhook:error:${err instanceof Error ? err.name : "unknown"}`;
      }
    }
    await this.sql.run(
      `INSERT INTO notifications (priority, title, body, fields, delivery, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        notification.priority,
        notification.title,
        notification.body,
        JSON.stringify(notification.fields),
        delivery,
        this.clock.now().toISOString(),
      ],
    );
    this.options.onNotify?.(notification);
  }
}
