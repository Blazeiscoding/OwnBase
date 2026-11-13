import { z } from "zod";
import {
  bytes,
  endpoint,
  extensionRoutes,
  json,
  page,
  text,
  type HttpMethod,
} from "@ownbase/protocol";
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

/** The longest certificates a SAML provider's settings may hold, as text. */
export const CERTIFICATES_MAX = 20_000;

/** What the owner's SAML panel sends: what changes, nothing else. */
export const samlSettingsBody = z.object({
  name: setting,
  signInUrl: setting,
  issuer: setting,
  /** One or more, as PEM or as their base64 alone, separated by commas. */
  certificate: z.string().max(CERTIFICATES_MAX).optional(),
  /** Separated by commas. */
  domains: setting,
  newAccounts: z.boolean().optional(),
  required: z.boolean().optional(),
});

/** What starting a sign-in may be asked for: a link ticket, or the app's client and challenge. */
const startQuery = z.object({
  link: z.string().optional(),
  client: z.string().optional(),
  challenge: z.string().optional(),
});

/** Single sign-on with SAML 2.0 (P11): this workspace as a service provider. */
export const samlEndpoints = {
  /**
   * This workspace's description as a service provider, for the identity
   * provider: its entity ID, where answers go, and that assertions must be signed.
   */
  samlMetadata: endpoint({
    method: "GET",
    path: "/api/saml/metadata",
    access: "public",
    answer: text,
  }),

  /** The button: off to the identity provider with a request it must answer. */
  samlStart: endpoint({
    method: "GET",
    path: "/api/saml/start",
    access: "public",
    query: startQuery,
    answer: page,
  }),

  /**
   * Where the identity provider's browser form posts its signed answer (the
   * assertion consumer service). Checked here, then finished by a GET.
   */
  samlAcs: endpoint({
    method: "POST",
    path: "/api/saml/acs",
    access: "public",
    body: z.object({
      SAMLResponse: z.string().max(400_000),
      RelayState: z.string().max(200).optional(),
    }),
    answer: page,
  }),

  /**
   * The checked answer, in the browser that began, which a POST from the
   * provider's site does not bring its cookie to: an account linked, or a code for the app.
   */
  samlFinish: endpoint({
    method: "GET",
    path: "/api/saml/finish",
    access: "public",
    query: z.object({ state: z.string().optional() }),
    answer: page,
  }),

  /** The app's code and its secret, for a session. */
  samlRedeem: endpoint({ ...extensionRoutes.redeemSignIn, path: "/api/saml/redeem" }),

  /** Whether the person signed in here has linked the identity provider's account. */
  samlConnection: endpoint({ ...extensionRoutes.signInConnection, path: "/api/saml/connect" }),

  /** Where to go to link it: a one-time link, for the browser that opens it. */
  samlConnect: endpoint({ ...extensionRoutes.connectSignIn, path: "/api/saml/connect" }),

  samlDisconnect: endpoint({ ...extensionRoutes.disconnectSignIn, path: "/api/saml/connect" }),

  /** The owner's settings, from the panel: what is sent changes. */
  samlSettings: endpoint({
    ...extensionRoutes.saveSettings,
    path: "/api/saml/settings",
    body: samlSettingsBody,
  }),
};

/**
 * A SCIM route (P10): the identity provider signs in with the token the
 * owner made, not a session, and every answer and refusal is SCIM's own
 * JSON, which the route sends itself.
 */
const scimRoute = <const M extends HttpMethod, const P extends string>(method: M, path: P) =>
  endpoint({ method, path, access: "public", answer: text });

export const scimEndpoints = {
  scimServiceProviderConfig: scimRoute("GET", "/scim/v2/ServiceProviderConfig"),
  scimResourceTypes: scimRoute("GET", "/scim/v2/ResourceTypes"),
  scimSchemas: scimRoute("GET", "/scim/v2/Schemas"),
  /** Everyone the provider may see, a page at a time, or those a filter picks. */
  scimListUsers: scimRoute("GET", "/scim/v2/Users"),
  scimCreateUser: scimRoute("POST", "/scim/v2/Users"),
  scimGetUser: scimRoute("GET", "/scim/v2/Users/:id"),
  scimReplaceUser: scimRoute("PUT", "/scim/v2/Users/:id"),
  scimPatchUser: scimRoute("PATCH", "/scim/v2/Users/:id"),
  /** Deactivates: nobody is deleted here. */
  scimDeleteUser: scimRoute("DELETE", "/scim/v2/Users/:id"),
  scimListGroups: scimRoute("GET", "/scim/v2/Groups"),
  /** Anything else under SCIM's address, answered in SCIM's shape rather than with the web app. */
  scimElsewhere: (["GET", "POST", "PUT", "PATCH", "DELETE"] as const).map((method) =>
    scimRoute(method, "/scim/v2/*"),
  ),

  /** The owner's button: a new token, shown once, replacing any before it. */
  scimMakeToken: endpoint({ ...extensionRoutes.settingsAction, path: "/api/scim/token" }),
  /** The owner's button: no token, so the provider can do nothing more. */
  scimTurnOff: endpoint({ ...extensionRoutes.settingsAction, path: "/api/scim/off" }),
};

/** Compliance (P12): the owner's panels and the export they download. */
export const complianceEndpoints = {
  /** The people and channels held, by usernames and channel names. */
  complianceHold: endpoint({ ...extensionRoutes.saveSettings, path: "/api/compliance/hold" }),
  /** What the next export covers: a range of days, and people, channels or both. */
  complianceExportChoice: endpoint({
    ...extensionRoutes.saveSettings,
    path: "/api/compliance/export/choice",
  }),
  /** The button: a one-time link that downloads the export as saved. */
  complianceExportLink: endpoint({
    ...extensionRoutes.settingsAction,
    path: "/api/compliance/export/link",
  }),
  /**
   * The export, made as it downloads: one zip of JSON lines and the files.
   * Opened with `?download=<ticket>` from the button's link.
   */
  complianceExport: endpoint({
    method: "GET",
    path: "/api/compliance/export",
    access: "owner",
    ticket: true,
    query: "downloadQuery",
    answer: bytes,
    timeoutMs: 300000,
  }),
  /** Where the administrative record is sent: a webhook, syslog, or both. */
  complianceStream: endpoint({ ...extensionRoutes.saveSettings, path: "/api/compliance/stream" }),
};

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
    query: startQuery,
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

  ...samlEndpoints,
  ...scimEndpoints,
  ...complianceEndpoints,
};
