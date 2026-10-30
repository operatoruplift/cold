import type { Platform } from "../../messages";
import type { Prospect } from "../../prospects";

/** How each platform is written in messages to the user. */
export const PLATFORM_NAMES: Record<Platform, string> = { linkedin: "LinkedIn", x: "X", instagram: "Instagram", facebook: "Facebook" };

/**
 * Where a DM to this prospect goes on a platform: the page to open, or
 * undefined when they have no profile there. Pure.
 *   LinkedIn  their profile (Connect, or Message once connected)
 *   X         their profile (the Message button)
 *   Instagram ig.me/m/<handle>, which opens the conversation
 *   Facebook  m.me/<handle>, Messenger (or the profile, for numeric ids)
 */
export function dmTarget(platform: Platform, prospect: Prospect): string | undefined {
  switch (platform) {
    case "linkedin":
      return prospect.linkedinUrl;
    case "x":
      return prospect.xHandle ? `https://x.com/${prospect.xHandle}` : undefined;
    case "instagram":
      return prospect.instagramHandle ? `https://ig.me/m/${prospect.instagramHandle}` : undefined;
    case "facebook": {
      const url = prospect.facebookUrl;
      if (!url) return undefined;
      const handle = /facebook\.com\/([^/?#]+)/i.exec(url)?.[1];
      // A numeric profile (profile.php?id=...) has no m.me link: open the profile.
      return handle && handle !== "profile.php" ? `https://m.me/${handle}` : url;
    }
  }
}
