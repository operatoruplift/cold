import type { Account, Offer } from "../../config";
import type { Prospect } from "../../prospects";
import type { Variables } from "../../render";

/**
 * Everything a message can fill for one prospect: the offer, then the
 * prospect's own fields (which may override an offer line, like a custom
 * pain), then the account. The account always wins for sender_* and the
 * other account variables, so a CSV column can never change who is sending.
 */
export function buildVariables(account: Account, offer: Offer | undefined, prospect?: Prospect): Variables {
  return { ...(offer?.variables ?? {}), ...(prospect?.variables ?? {}), ...account.variables };
}
