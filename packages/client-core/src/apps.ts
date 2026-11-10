import type { AppScope, CreateCommandBody, CreateSubscriptionBody, ID } from "@ownbase/protocol";
import type { Api } from "./api.js";

/**
 * The workspace's apps and what each is given: tokens, webhooks, commands,
 * event subscriptions and the address that answers its buttons and forms.
 * For administrators; nothing here is kept in the workspace's store.
 */
export class AppActions {
  constructor(private readonly api: Api) {}

  list() {
    return this.api.listApps();
  }

  /** The bot token comes back once here and is never retrievable again. */
  create(body: { name: string; scopes: AppScope[] }) {
    return this.api.createApp(body);
  }

  remove(appId: ID) {
    return this.api.deleteApp(appId);
  }

  setScopes(appId: ID, scopes: AppScope[]) {
    return this.api.setAppScopes(appId, scopes);
  }

  /** Replaces every bot token the app has; the old ones stop working at once. */
  replaceToken(appId: ID) {
    return this.api.replaceAppToken(appId);
  }

  replaceSigningSecret(appId: ID) {
    return this.api.replaceSigningSecret(appId);
  }

  setInteractivityUrl(appId: ID, url: string) {
    return this.api.setInteractivityUrl(appId, url);
  }

  createWebhook(appId: ID, channelId: ID) {
    return this.api.createWebhook(appId, { channelId });
  }

  /** A new URL for the same webhook and channel; the old URL stops working. */
  replaceWebhookUrl(webhookId: ID) {
    return this.api.replaceWebhookUrl(webhookId);
  }

  removeWebhook(webhookId: ID) {
    return this.api.deleteWebhook(webhookId);
  }

  /** Posts to an incoming webhook's URL as any other tool would, so a test proves the URL works. */
  postToWebhook(url: string, payload: { text: string }) {
    return this.api.postToWebhook(url, payload);
  }

  createCommand(appId: ID, body: CreateCommandBody) {
    return this.api.createCommand(appId, body);
  }

  removeCommand(commandId: ID) {
    return this.api.deleteCommand(commandId);
  }

  /** A command whose app failed answers `ok: false` with why, in `message`. */
  runCommand(channelId: ID, text: string) {
    return this.api.runCommand(channelId, { text });
  }

  /** The server calls the URL to verify it before this resolves. */
  subscribe(appId: ID, body: CreateSubscriptionBody) {
    return this.api.createSubscription(appId, body);
  }

  retrySubscription(subscriptionId: ID) {
    return this.api.retrySubscription(subscriptionId);
  }

  removeSubscription(subscriptionId: ID) {
    return this.api.deleteSubscription(subscriptionId);
  }
}
