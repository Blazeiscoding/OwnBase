import { Bonjour } from "bonjour-service";
import { MDNS_SERVICE_TYPE, PROTOCOL_VERSION, type DiscoveryTxt } from "@ownbase/protocol";
import { SERVER_VERSION } from "./version.js";

export interface MdnsHandle {
  stop: () => void;
}

/** Advertise this workspace on the local network so clients can list it on the Join screen. */
export function advertise(opts: {
  name: string;
  port: number;
  instanceId: string;
  iconVersion: string | null;
}): MdnsHandle {
  const bonjour = new Bonjour();
  const service = bonjour.publish({
    name: `${opts.name} (OwnBase)`,
    type: MDNS_SERVICE_TYPE,
    port: opts.port,
    txt: discoveryTxt(opts),
  });
  return {
    stop: () => {
      service.stop?.();
      bonjour.destroy();
    },
  };
}

/** What the announcement says of the workspace: the icon's version only when it has one. */
export function discoveryTxt(opts: {
  name: string;
  instanceId: string;
  iconVersion: string | null;
}): DiscoveryTxt {
  return {
    name: opts.name,
    ver: SERVER_VERSION,
    proto: String(PROTOCOL_VERSION),
    inst: opts.instanceId,
    ...(opts.iconVersion ? { icon: opts.iconVersion } : {}),
  };
}
