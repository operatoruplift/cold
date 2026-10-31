// The Vercel function: everything under /api. See src/domains/web/vercel.
import { vercelHandler } from "../src/domains/web/vercel";

export default { fetch: vercelHandler };
