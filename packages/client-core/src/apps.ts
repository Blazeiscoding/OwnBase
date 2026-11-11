import type { AppScope, CreateCommandBody, CreateSubscriptionBody, ID } from "@ownbase/protocol";
import type { Api } from "./api.js";
import { answerOf, doneOf } from "./answers.js";

/**
 * The workspace's apps and what each is given: tokens, webhooks, commands,
 * event subscriptions and the address that answers its buttons and forms.
 * For administrators; nothing here is kept in the workspace's store. Each
 * answers what the server said, or the `ApiError` saying why not.
 */
export class AppActions {
  constructor(
    private readonly api: Api,
    /** Loads the `/` hint list again after commands come or go. */
    private readonly refreshCommands: () => void,
  ) {}

  list() {
    return answerOf(async () => (await this.api.listApps()).apps);
  }

  /** The bot token comes back once here and is never retrievable again. */
  create(body: { name: string; scopes: AppScope[] }) {
    return answerOf(() => this.api.createApp(body));
  }

  /** Its commands go with it. */
  async remove(appId: ID) {
    const failed = await doneOf(() => this.api.deleteApp(appId));
    this.refreshCommands();
    return failed;
  }

  setScopes(appId: ID, scopes: AppScope[]) {
    return doneOf(() => this.api.setAppScopes(appId, scopes));
  }

  /** Replaces every bot token the app has; the old ones stop working at once. */
  replaceToken(appId: ID) {
    return answerOf(async () => (await this.api.replaceAppToken(appId)).token);
  }

  replaceSigningSecret(appId: ID) {
    return doneOf(() => this.api.replaceSigningSecret(appId));
  }

  setInteractivityUrl(appId: ID, url: string) {
    return doneOf(() => this.api.setInteractivityUrl(appId, url));
  }

  createWebhook(appId: ID, channelId: ID) {
    return answerOf(() => this.api.createWebhook(appId, { channelId }));
  }

  /** A new URL for the same webhook and channel; the old URL stops working. */
  replaceWebhookUrl(webhookId: ID) {
    return answerOf(async () => (await this.api.replaceWebhookUrl(webhookId)).url);
  }

  removeWebhook(webhookId: ID) {
    return doneOf(() => this.api.deleteWebhook(webhookId));
  }

  /** Posts to an incoming webhook's URL as any other tool would, so a test proves the URL works. */
  postToWebhook(url: string, payload: { text: string }) {
    return doneOf(() => this.api.postToWebhook(url, payload));
  }

  createCommand(appId: ID, body: CreateCommandBody) {
    return answerOf(async () => {
      const { command } = await this.api.createCommand(appId, body);
      this.refreshCommands();
      return command;
    });
  }

  removeCommand(commandId: ID) {
    return doneOf(async () => {
      await this.api.deleteCommand(commandId);
      this.refreshCommands();
    });
  }

  /** A command whose app failed answers `ok: false` with why, in `message`. */
  runCommand(channelId: ID, text: string) {
    return answerOf(() => this.api.runCommand(channelId, { text }));
  }

  /** The server calls the URL to verify it before this resolves. */
  subscribe(appId: ID, body: CreateSubscriptionBody) {
    return doneOf(() => this.api.createSubscription(appId, body));
  }

  retrySubscription(subscriptionId: ID) {
    return doneOf(() => this.api.retrySubscription(subscriptionId));
  }

  removeSubscription(subscriptionId: ID) {
    return doneOf(() => this.api.deleteSubscription(subscriptionId));
  }
}
