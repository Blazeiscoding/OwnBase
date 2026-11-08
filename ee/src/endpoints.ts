import { z } from "zod";
import { endpoint, extensionRoutes, json, page } from "@ownbase/protocol";
import type { LicenseView } from "./enterprise.js";

/** The longest a setting of single sign-on may be, as text. */
export const TEXT_MAX = 500;

const setting = z.string().max(TEXT_MAX).optional();

/** What the owner's single sign-on panel sends: what changes, nothing else. */
export const ssoSettingsBody = z.object({
  name: setting,
  issuer: setting,
  clientId: setting,
  /** Left empty, the one set already stays. */
  clientSecret: setting,
  /** Separated by commas. */
  domains: setting,
  newAccounts: z.boolean().optional(),
  required: z.boolean().optional(),
});

/**
 * The Enterprise edition's routes, declared as the server's own are in
 * `endpoints`, and registered through the same `route()`. Those a client
 * reaches at a path the server names keep the shape `extensionRoutes` gives.
 */
export const eeEndpoints = {
  /** The license, where it stands now, for the owner and admins. */
  license: endpoint({
    method: "GET",
    path: "/api/admin/license",
    access: "admin",
    answer: json<LicenseView>(),
  }),

  /** The button: off to the provider, with what the way back must bring. */
  ssoStart: endpoint({
    method: "GET",
    path: "/api/sso/start",
    access: "public",
    query: z.object({
      link: z.string().optional(),
      client: z.string().optional(),
      challenge: z.string().optional(),
    }),
    answer: page,
  }),

  /** The way back from the provider: an account linked, or a code for the app. */
  ssoCallback: endpoint({
    method: "GET",
    path: "/api/sso/callback",
    access: "public",
    query: z.object({
      state: z.string().optional(),
      code: z.string().optional(),
      error: z.string().optional(),
      error_description: z.string().optional(),
    }),
    answer: page,
  }),

  /** The app's code and its secret, for a session. */
  ssoRedeem: endpoint({ ...extensionRoutes.redeemSignIn, path: "/api/sso/redeem" }),

  /** Whether the person signed in here has linked the provider's account. */
  ssoConnection: endpoint({ ...extensionRoutes.signInConnection, path: "/api/sso/connect" }),

  /**
   * Where to go to link it: a one-time link, for the browser that opens it.
   * Guests reach it to be told why they cannot.
   */
  ssoConnect: endpoint({ ...extensionRoutes.connectSignIn, path: "/api/sso/connect" }),

  ssoDisconnect: endpoint({ ...extensionRoutes.disconnectSignIn, path: "/api/sso/connect" }),

  /** The owner's settings, from the panel: what is sent changes, a secret left empty stays. */
  ssoSettings: endpoint({
    ...extensionRoutes.saveSettings,
    path: "/api/sso/settings",
    body: ssoSettingsBody,
  }),
};
