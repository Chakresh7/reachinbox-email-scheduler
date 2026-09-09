import type { Logger } from "../lib/logger";

/**
 * Request augmentation.
 *
 * `user` is populated by the requireAuth middleware in Phase 4. It is declared
 * here now so route handlers written before then are typed correctly rather
 * than casting through `any`.
 */
declare global {
  namespace Express {
    interface AuthenticatedUser {
      id: string;
      email: string;
      name: string;
      avatarUrl: string | null;
      isAdmin: boolean;
    }

    interface Request {
      /** Correlation id, also echoed as the `x-request-id` response header. */
      id: string;
      /** Logger pre-bound with this request's correlation id. */
      log: Logger;
      /** Present only after requireAuth has run. */
      user?: AuthenticatedUser;
    }
  }
}

export {};
