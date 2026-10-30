import { AtSign, Ban, Mail, MailX, MessageSquareReply, Phone, Send, ShieldAlert, XCircle, type LucideIcon } from "lucide-react";
import type { Touch } from "../../domains/touches/types";
import { Pill, type Tone } from "./kit";
import { FacebookMark, InstagramMark, LinkedinMark, XMark, type IconLike } from "./marks";

const KIND: Record<Touch["kind"], { label: string; tone: Tone; icon: LucideIcon }> = {
  SENT: { label: "Sent", tone: "blue", icon: Send },
  REPLIED: { label: "Replied", tone: "green", icon: MessageSquareReply },
  OPTED_OUT: { label: "Opted out", tone: "red", icon: Ban },
  BOUNCED: { label: "Bounced", tone: "amber", icon: MailX },
  UNDELIVERABLE: { label: "Undeliverable", tone: "gray", icon: ShieldAlert },
  FAILED: { label: "Failed", tone: "red", icon: XCircle },
  CALLED: { label: "Called", tone: "purple", icon: Phone },
};

const CHANNEL: Record<Touch["channel"], { label: string; icon: IconLike }> = {
  EMAIL: { label: "Email", icon: Mail },
  LINKEDIN: { label: "LinkedIn", icon: LinkedinMark },
  X: { label: "X", icon: XMark },
  INSTAGRAM: { label: "Instagram", icon: InstagramMark },
  FACEBOOK: { label: "Facebook", icon: FacebookMark },
  CALL: { label: "Call", icon: Phone },
};

export function KindPill({ kind }: { kind: Touch["kind"] }) {
  const k = KIND[kind] ?? KIND.SENT;
  return (
    <Pill tone={k.tone} icon={k.icon}>
      {k.label}
    </Pill>
  );
}

export function ChannelLabel({ channel }: { channel: Touch["channel"] }) {
  const c = CHANNEL[channel] ?? { label: channel, icon: AtSign };
  const Icon = c.icon;
  return (
    <span className="row text-2" style={{ gap: 6 }}>
      <Icon size={14} className="text-3" />
      {c.label}
    </span>
  );
}

/** The icon for a channel and platform: email, call, or a DM platform's mark. */
export function sequenceChannelIcon(channel: "email" | "dm" | "call", platform?: string): IconLike {
  if (channel === "email") return Mail;
  if (channel === "call") return Phone;
  return CHANNEL[(platform ?? "").toUpperCase() as Touch["channel"]]?.icon ?? AtSign;
}
