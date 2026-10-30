/** Whose problem a failed send is. */
export type SmtpFailure =
  /** The recipient's server refused this address for good (550 on RCPT TO): a bounce. */
  | "recipient"
  /** The sending mailbox cannot send right now (auth, connection, a sending limit, a refused message): stop the run. */
  | "mailbox"
  /** A temporary refusal (4xx): try again on a later run. */
  | "temporary"
  | "other";

/** Errors that mean the mailbox itself is unusable. */
const MAILBOX_CODES = new Set(["EAUTH", "ENOAUTH", "EOAUTH2", "ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS", "ETLS", "EPROXY"]);

/**
 * Classify a nodemailer error. Pure. Only a permanent refusal of the
 * recipient (RCPT TO) is the recipient's bounce. A refused sender (MAIL FROM,
 * e.g. "550 Daily user sending limit exceeded") or a refused message (DATA)
 * says nothing about the address and stops the run instead.
 */
export function classifySmtpFailure(err: { code?: string; responseCode?: number; command?: string }): SmtpFailure {
  if (MAILBOX_CODES.has(err.code ?? "")) return "mailbox";
  const status = err.responseCode ?? 0;
  const command = (err.command ?? "").toUpperCase();
  if (status >= 400 && status < 500) return "temporary";
  if (command.startsWith("RCPT") && status >= 500) return "recipient";
  if (command.startsWith("MAIL") || command.startsWith("AUTH") || command === "DATA" || err.code === "EMESSAGE") return "mailbox";
  return "other";
}
