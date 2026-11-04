/** COLD's API as a function: the same handler the app's server answers /api with. */
export type ApiHandler = (request: Request) => Promise<Response>;

/** What a tool answers with: Markdown to read, or the API's JSON as it is. */
export type ResponseFormat = "markdown" | "json";

/** A tool's text stays under this; longer lists come back in pages. */
export const CHARACTER_LIMIT = 25_000;

/** A page of a list, unless a tool asks for another size. */
export const PAGE_SIZE = 20;

/** The MCP server's name, as clients list it. */
export const SERVER_NAME = "cold-mcp-server";
