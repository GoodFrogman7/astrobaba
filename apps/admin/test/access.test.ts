import { describe, expect, it, vi } from "vitest";
import { decideAccess, withAdmin } from "../src/lib/access";
import type { Me } from "../src/lib/types";

const admin: Me = { id: "u1", phone: "+91•••••43210", roles: ["admin"] };
const user: Me = { id: "u2", phone: "+91•••••00000", roles: [] };

describe("admin access guard", () => {
  it("classifies sessions", () => {
    expect(decideAccess(null).kind).toBe("anon");
    expect(decideAccess(user).kind).toBe("forbidden");
    expect(decideAccess({ ...user, roles: undefined }).kind).toBe("forbidden");
    expect(decideAccess(admin).kind).toBe("admin");
  });

  it("never loads data for anonymous or non-admin sessions", async () => {
    for (const me of [null, user]) {
      const load = vi.fn(async () => "secret");
      const r = await withAdmin(async () => me, load);
      expect(load).not.toHaveBeenCalled();
      expect(r.data).toBeNull();
    }
  });

  it("loads data for admins", async () => {
    const r = await withAdmin(
      async () => admin,
      async (me) => `data for ${me.id}`,
    );
    expect(r).toEqual({ access: { kind: "admin", me: admin }, data: "data for u1" });
  });
});
