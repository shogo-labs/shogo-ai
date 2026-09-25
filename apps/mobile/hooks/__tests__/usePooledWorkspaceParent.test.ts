import { describe, expect, test } from "bun:test";
import { selectPooledWorkspaceParent } from "../pooledWorkspaceParent";

const plans = {
  free: { planId: "free", canManageChildren: true },
  pro: { planId: "pro", canManageChildren: true },
  business: { planId: "business", canManageChildren: true },
  enterprise: { planId: "enterprise", canManageChildren: true },
  enterpriseMember: { planId: "enterprise", canManageChildren: false },
};

describe("selectPooledWorkspaceParent", () => {
  test("prefers the current eligible top-level workspace", () => {
    const workspaces = [
      { id: "business", name: "Business", parentWorkspaceId: null },
      { id: "enterprise", name: "Enterprise", parentWorkspaceId: null },
    ];

    expect(selectPooledWorkspaceParent(workspaces, "enterprise", plans)).toEqual(
      workspaces[1],
    );
  });

  test("skips child workspaces and free or pro plans", () => {
    const workspaces = [
      { id: "free", name: "Free", parentWorkspaceId: null },
      { id: "pro", name: "Pro", parentWorkspaceId: null },
      { id: "child", name: "Child", parentWorkspaceId: "enterprise" },
      { id: "enterprise", name: "Enterprise", parentWorkspaceId: null },
    ];

    expect(selectPooledWorkspaceParent(workspaces, "child", plans)).toEqual(
      workspaces[3],
    );
  });

  test("skips Enterprise workspaces the user can't manage", () => {
    const workspaces = [
      { id: "enterpriseMember", name: "Acme", parentWorkspaceId: null },
    ];

    expect(
      selectPooledWorkspaceParent(workspaces, "enterpriseMember", plans),
    ).toBeNull();
  });

  test("returns null when no eligible parent exists", () => {
    const workspaces = [
      { id: "free", name: "Free", parentWorkspaceId: null },
      { id: "pro", name: "Pro", parentWorkspaceId: null },
    ];

    expect(selectPooledWorkspaceParent(workspaces, undefined, plans)).toBeNull();
  });
});
