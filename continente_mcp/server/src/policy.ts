/**
 * Tool policy. Every agent token may read the catalogue and read and change the cart. Anything that
 * looks like checkout, payment or placing an order is hidden and refused unless the add-on option
 * `allow_checkout` is on (default off). Tools not in the reviewed snapshot are never exposed.
 *
 * 1.0.3: coupon and voucher tools (continentept-mcp 0.13.0 `list_coupons`, `set_cart_coupons`) are never
 * exposed, whatever `allow_checkout` says: they are not checkout, so that option must not be the way to
 * reach them, and how to offer them (per token, read-only first) is still under review.
 */
export const CART_TOOLS = ['add_cart_item', 'set_cart_item_quantity', 'remove_cart_item', 'clear_cart'] as const;

/** Same pattern as FORBIDDEN in scripts/upstream-tools.mjs (a test keeps them equal). */
export const CHECKOUT_TOOL = /checkout|pay|order_(create|place|submit|confirm)|(place|submit|confirm|create|finali[sz]e)_?order|purchase|buy|slot|deliver|voucher|coupon|billing|card/i;

export const isCheckoutTool = (name: string) => CHECKOUT_TOOL.test(name);
/** Never listed or called, even with `allow_checkout` on (see above). */
export const NEVER_EXPOSED_TOOL = /coupon|voucher/i;
export const isNeverExposed = (name: string) => NEVER_EXPOSED_TOOL.test(name);
/** Calls that can change the cart or go past it: logged with the agent name. */
export const isCartChange = (name: string) => (CART_TOOLS as readonly string[]).includes(name) || isCheckoutTool(name);

export class ToolPolicy {
  private readonly reviewed: Set<string>;
  constructor(reviewed: readonly string[], private readonly allowCheckout: () => boolean) {
    this.reviewed = new Set(reviewed);
  }
  /** True when `name` may be listed and called. */
  allows(name: string): boolean {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(name)) return false;
    if (isNeverExposed(name)) return false;
    if (isCheckoutTool(name)) return this.allowCheckout() && this.reviewed.has(name);
    return this.reviewed.has(name);
  }
}
