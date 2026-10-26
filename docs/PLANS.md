# Plans

A proposal for how OwnBase pays for itself. Nothing here is built or on sale yet.

|                     | Self-hosted                   | Team                                                                        | Enterprise                                                            |
| ------------------- | ----------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Price               | Free                          | $20 a month per workspace, or $200 a year                                   | Annual contract                                                       |
| Who runs the server | You                           | We do                                                                       | You, or we do on a dedicated server                                   |
| Members             | No limit                      | Up to 50                                                                    | Set in the contract                                                   |
| What it adds        | Everything in this repository | Hosting, daily backups, updates, a stable HTTPS address, export at any time | SSO and SCIM, audit log, compliance export, high availability, an SLA |
| Support             | GitHub issues                 | Email                                                                       | SLA                                                                   |

A Business step, about $59 a month for up to 200 members and 100 GB, sits
between Team and Enterprise for teams that outgrow 50 members.

## Self-hosted

Free for anyone, companies included. The MIT license already allows commercial
use, so a "personal use only" rule could not be enforced. Companies that
self-host are also the ones most likely to buy Enterprise later.

## Team

We run the server. Each workspace is its own server process and data folder, so
it costs about the same to host with 5 members as with 50. That is why the price
is per workspace, not per person. Hosted chat elsewhere is usually priced per
person, roughly $7–10 a month each.

Limits keep one workspace from costing more than it pays:

- 25 GB of files.
- The TURN relay for huddles is fair use. Relayed video is the largest running
  cost, because a huddle is a mesh and every relayed person is another stream.
- At member 51 the owner is told and offered Business. Chat never locks.

The workspace is one folder. The owner can download it and move to their own
server at any time, which keeps the "Your server" promise.

Setting OwnBase up once on a customer's own server is a separate, paid add-on.

## Enterprise

Companies can already run the MIT code for free, so Enterprise sells what the
code does not include:

- SSO (SAML and OIDC) and SCIM provisioning.
- An audit log, compliance export and legal hold. Message retention stays free.
- Postgres, S3 and high availability.
- Signed builds, an update channel and answers to security questionnaires.
- Support with an SLA, and a warranty, which MIT disclaims.

The starting price is $5 per member a month, billed yearly, with a 100-member
minimum ($6,000 a year). Until SSO ships, early deals are sold as support
contracts.

## Licensing

Open core. The code in this repository stays MIT. Enterprise features live in a
separate `ee/` folder under a commercial license and turn on with a license key.

So far every contribution has come from one person, so future versions can be
licensed this way without asking anyone. Versions already released stay MIT. A
contributor license agreement before the first outside contribution keeps that
choice open.

## Order of work

1. Clear the name. OwnBase has not been trademark-cleared.
2. Terms of service, a privacy policy and a data processing agreement for Team,
   since we will hold customers' messages. GDPR applies to anyone in the EU.
3. Billing through a merchant of record such as Paddle or Lemon Squeezy, which
   collects and pays sales tax and VAT.
4. Team hosting: a server process per workspace, backups, storage limits and
   export.
5. SSO, the first Enterprise feature, then the audit log and SCIM.
6. Signed releases and an update channel. Enterprise buyers ask for both, and
   [Current boundaries](DEPLOYMENT.md#current-boundaries) lists them as missing.

## Open questions

- Does Business launch with Team, or only once a Team workspace reaches 50
  members?
- Is the TURN relay part of Team, or an add-on?
- Is $20 a launch price that early customers keep?
