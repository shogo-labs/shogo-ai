/**
 * TenantDemoPage - Demo page for Teams Multi-Tenancy domain
 *
 * Demonstrates the multi-tenant data model:
 * - User management
 * - Tenant CRUD
 * - TenantMember management with roles (admin, billing_admin, editor, member)
 * - BillingAccount management with credits
 * - Workspace CRUD with dual references (tenant + billing account)
 */

import { useState } from "react"
import { observer } from "mobx-react-lite"
import { useDomains } from "../contexts/DomainProvider"

// Styles (shared with TeamsDemoPage)
const containerStyle = {
  maxWidth: "1000px",
  margin: "2rem auto",
  padding: "2rem",
  background: "#1e1e1e",
  borderRadius: "8px",
  color: "white",
}

const sectionStyle = {
  marginBottom: "2rem",
  padding: "1.5rem",
  background: "#2a2a2a",
  borderRadius: "8px",
}

const formStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "1rem",
}

const rowStyle = {
  display: "flex",
  gap: "1rem",
  flexWrap: "wrap" as const,
}

const inputGroupStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.5rem",
  flex: "1 1 200px",
}

const labelStyle = {
  fontSize: "0.9rem",
  fontWeight: "bold" as const,
}

const inputStyle = {
  padding: "0.75rem",
  borderRadius: "4px",
  border: "1px solid #444",
  background: "#333",
  color: "white",
  fontSize: "1rem",
}

const selectStyle = {
  ...inputStyle,
  cursor: "pointer",
}

const buttonStyle = {
  padding: "0.75rem 1.5rem",
  borderRadius: "4px",
  border: "none",
  background: "#2196f3",
  color: "white",
  fontSize: "1rem",
  fontWeight: "bold" as const,
  cursor: "pointer",
}

const errorStyle = {
  padding: "0.75rem",
  borderRadius: "4px",
  background: "#ff5252",
  color: "white",
  marginBottom: "1rem",
}

const listItemStyle = {
  padding: "0.75rem",
  background: "#333",
  borderRadius: "4px",
  marginBottom: "0.5rem",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
}

const badgeStyle = (color: string) => ({
  display: "inline-block",
  padding: "0.25rem 0.5rem",
  borderRadius: "4px",
  background: color,
  fontSize: "0.75rem",
  fontWeight: "bold" as const,
  marginLeft: "0.5rem",
})

const tabContainerStyle = {
  display: "flex",
  gap: "0.5rem",
  marginBottom: "1.5rem",
  borderBottom: "2px solid #333",
  paddingBottom: "0.5rem",
}

const tabStyle = (active: boolean) => ({
  padding: "0.75rem 1.5rem",
  borderRadius: "4px 4px 0 0",
  border: "none",
  background: active ? "#2196f3" : "#444",
  color: "white",
  fontSize: "1rem",
  fontWeight: "bold" as const,
  cursor: "pointer",
})

type Tab = "users" | "tenants" | "members" | "billing" | "workspaces"

export const TenantDemoPage = observer(function TenantDemoPage() {
  const { multiTenancy } = useDomains()
  const [activeTab, setActiveTab] = useState<Tab>("tenants")
  const [error, setError] = useState<string | null>(null)

  // Form state
  const [userName, setUserName] = useState("")
  const [userEmail, setUserEmail] = useState("")
  const [tenantName, setTenantName] = useState("")
  const [tenantSso, setTenantSso] = useState("")
  const [memberId, setMemberId] = useState("")
  const [memberTenant, setMemberTenant] = useState("")
  const [memberRole, setMemberRole] = useState<string>("member")
  const [billingTenant, setBillingTenant] = useState("")
  const [billingStripeId, setBillingStripeId] = useState("")
  const [billingTaxId, setBillingTaxId] = useState("")
  const [billingCredits, setBillingCredits] = useState("0")
  const [workspaceName, setWorkspaceName] = useState("")
  const [workspaceTenant, setWorkspaceTenant] = useState("")
  const [workspaceBilling, setWorkspaceBilling] = useState("")

  // Data from store
  const users = multiTenancy.userCollection.all()
  const tenants = multiTenancy.tenantCollection.all()
  const members = multiTenancy.tenantMemberCollection.all()
  const billingAccounts = multiTenancy.billingAccountCollection.all()
  const workspaces = multiTenancy.workspaceCollection.all()

  // Handlers
  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      await multiTenancy.userCollection.insertOne({
        id: crypto.randomUUID(),
        name: userName,
        email: userEmail,
      })
      setUserName("")
      setUserEmail("")
    } catch (err: any) {
      setError(err.message || "Failed to create user")
    }
  }

  const handleCreateTenant = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      await multiTenancy.tenantCollection.insertOne({
        id: crypto.randomUUID(),
        name: tenantName,
        sso_settings: tenantSso || undefined,
      })
      setTenantName("")
      setTenantSso("")
    } catch (err: any) {
      setError(err.message || "Failed to create tenant")
    }
  }

  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!memberId || !memberTenant) {
      setError("Select a user and tenant")
      return
    }
    try {
      await multiTenancy.tenantMemberCollection.insertOne({
        id: crypto.randomUUID(),
        user_id: memberId,
        tenant_id: memberTenant,
        role: memberRole,
      })
      setMemberId("")
      setMemberTenant("")
      setMemberRole("member")
    } catch (err: any) {
      setError(err.message || "Failed to add member")
    }
  }

  const handleCreateBilling = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!billingTenant) {
      setError("Select a tenant")
      return
    }
    try {
      await multiTenancy.billingAccountCollection.insertOne({
        id: crypto.randomUUID(),
        tenant_id: billingTenant,
        stripe_customer_id: billingStripeId || undefined,
        tax_id: billingTaxId || undefined,
        credits_balance: parseInt(billingCredits) || 0,
      })
      setBillingTenant("")
      setBillingStripeId("")
      setBillingTaxId("")
      setBillingCredits("0")
    } catch (err: any) {
      setError(err.message || "Failed to create billing account")
    }
  }

  const handleCreateWorkspace = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!workspaceTenant || !workspaceBilling) {
      setError("Select a tenant and billing account")
      return
    }
    try {
      await multiTenancy.workspaceCollection.insertOne({
        id: crypto.randomUUID(),
        name: workspaceName,
        tenant_id: workspaceTenant,
        billing_account_id: workspaceBilling,
      })
      setWorkspaceName("")
      setWorkspaceTenant("")
      setWorkspaceBilling("")
    } catch (err: any) {
      setError(err.message || "Failed to create workspace")
    }
  }

  const getRoleBadgeColor = (role: string) => {
    switch (role) {
      case "admin":
        return "#e91e63"
      case "billing_admin":
        return "#ff9800"
      case "editor":
        return "#4caf50"
      case "member":
        return "#2196f3"
      default:
        return "#666"
    }
  }

  return (
    <div style={containerStyle}>
      <h1>Multi-Tenancy Demo</h1>
      <p style={{ color: "#888", marginBottom: "1.5rem" }}>
        Demonstrates User, Tenant, TenantMember, BillingAccount, and Workspace entities
        with reference resolution and computed views.
      </p>

      {error && <div style={errorStyle}>{error}</div>}

      {/* Tabs */}
      <div style={tabContainerStyle}>
        <button style={tabStyle(activeTab === "tenants")} onClick={() => setActiveTab("tenants")}>
          Tenants ({tenants.length})
        </button>
        <button style={tabStyle(activeTab === "users")} onClick={() => setActiveTab("users")}>
          Users ({users.length})
        </button>
        <button style={tabStyle(activeTab === "members")} onClick={() => setActiveTab("members")}>
          Members ({members.length})
        </button>
        <button style={tabStyle(activeTab === "billing")} onClick={() => setActiveTab("billing")}>
          Billing ({billingAccounts.length})
        </button>
        <button style={tabStyle(activeTab === "workspaces")} onClick={() => setActiveTab("workspaces")}>
          Workspaces ({workspaces.length})
        </button>
      </div>

      {/* Users Tab */}
      {activeTab === "users" && (
        <div style={sectionStyle}>
          <h2>Users</h2>
          <form onSubmit={handleCreateUser} style={formStyle}>
            <div style={rowStyle}>
              <div style={inputGroupStyle}>
                <label style={labelStyle}>Name</label>
                <input
                  type="text"
                  value={userName}
                  onChange={(e) => setUserName(e.target.value)}
                  style={inputStyle}
                  placeholder="Alice Smith"
                  required
                />
              </div>
              <div style={inputGroupStyle}>
                <label style={labelStyle}>Email</label>
                <input
                  type="email"
                  value={userEmail}
                  onChange={(e) => setUserEmail(e.target.value)}
                  style={inputStyle}
                  placeholder="alice@example.com"
                  required
                />
              </div>
            </div>
            <button type="submit" style={buttonStyle}>Create User</button>
          </form>

          <h3 style={{ marginTop: "1.5rem" }}>All Users</h3>
          {users.length === 0 ? (
            <p style={{ color: "#888" }}>No users yet.</p>
          ) : (
            users.map((user: any) => (
              <div key={user.id} style={listItemStyle}>
                <span>
                  <strong>{user.name}</strong> - {user.email}
                </span>
                <span style={{ fontSize: "0.75rem", color: "#888" }}>{user.id.slice(0, 8)}...</span>
              </div>
            ))
          )}
        </div>
      )}

      {/* Tenants Tab */}
      {activeTab === "tenants" && (
        <div style={sectionStyle}>
          <h2>Tenants</h2>
          <form onSubmit={handleCreateTenant} style={formStyle}>
            <div style={rowStyle}>
              <div style={inputGroupStyle}>
                <label style={labelStyle}>Tenant Name</label>
                <input
                  type="text"
                  value={tenantName}
                  onChange={(e) => setTenantName(e.target.value)}
                  style={inputStyle}
                  placeholder="Acme Corp"
                  required
                />
              </div>
              <div style={inputGroupStyle}>
                <label style={labelStyle}>SSO Settings (optional JSON)</label>
                <input
                  type="text"
                  value={tenantSso}
                  onChange={(e) => setTenantSso(e.target.value)}
                  style={inputStyle}
                  placeholder='{"provider":"okta"}'
                />
              </div>
            </div>
            <button type="submit" style={buttonStyle}>Create Tenant</button>
          </form>

          <h3 style={{ marginTop: "1.5rem" }}>All Tenants</h3>
          {tenants.length === 0 ? (
            <p style={{ color: "#888" }}>No tenants yet.</p>
          ) : (
            tenants.map((tenant: any) => (
              <div key={tenant.id} style={listItemStyle}>
                <span>
                  <strong>{tenant.name}</strong>
                  {tenant.sso_settings && (
                    <span style={badgeStyle("#9c27b0")}>SSO</span>
                  )}
                </span>
                <span style={{ fontSize: "0.75rem", color: "#888" }}>{tenant.id.slice(0, 8)}...</span>
              </div>
            ))
          )}
        </div>
      )}

      {/* Members Tab */}
      {activeTab === "members" && (
        <div style={sectionStyle}>
          <h2>Tenant Members</h2>
          <form onSubmit={handleAddMember} style={formStyle}>
            <div style={rowStyle}>
              <div style={inputGroupStyle}>
                <label style={labelStyle}>User</label>
                <select
                  value={memberId}
                  onChange={(e) => setMemberId(e.target.value)}
                  style={selectStyle}
                  required
                >
                  <option value="">Select user...</option>
                  {users.map((user: any) => (
                    <option key={user.id} value={user.id}>{user.name}</option>
                  ))}
                </select>
              </div>
              <div style={inputGroupStyle}>
                <label style={labelStyle}>Tenant</label>
                <select
                  value={memberTenant}
                  onChange={(e) => setMemberTenant(e.target.value)}
                  style={selectStyle}
                  required
                >
                  <option value="">Select tenant...</option>
                  {tenants.map((tenant: any) => (
                    <option key={tenant.id} value={tenant.id}>{tenant.name}</option>
                  ))}
                </select>
              </div>
              <div style={inputGroupStyle}>
                <label style={labelStyle}>Role</label>
                <select
                  value={memberRole}
                  onChange={(e) => setMemberRole(e.target.value)}
                  style={selectStyle}
                >
                  <option value="admin">Admin</option>
                  <option value="billing_admin">Billing Admin</option>
                  <option value="editor">Editor</option>
                  <option value="member">Member</option>
                </select>
              </div>
            </div>
            <button type="submit" style={buttonStyle}>Add Member</button>
          </form>

          <h3 style={{ marginTop: "1.5rem" }}>All Members</h3>
          {members.length === 0 ? (
            <p style={{ color: "#888" }}>No members yet. Create users and tenants first.</p>
          ) : (
            members.map((member: any) => (
              <div key={member.id} style={listItemStyle}>
                <span>
                  <strong>{member.user_id?.name || "Unknown"}</strong>
                  {" @ "}
                  {member.tenant_id?.name || "Unknown"}
                  <span style={badgeStyle(getRoleBadgeColor(member.role))}>{member.role}</span>
                  {member.isBillingAdmin && (
                    <span style={badgeStyle("#ff9800")}>Can Manage Billing</span>
                  )}
                </span>
              </div>
            ))
          )}
        </div>
      )}

      {/* Billing Tab */}
      {activeTab === "billing" && (
        <div style={sectionStyle}>
          <h2>Billing Accounts</h2>
          <form onSubmit={handleCreateBilling} style={formStyle}>
            <div style={rowStyle}>
              <div style={inputGroupStyle}>
                <label style={labelStyle}>Tenant (Owner)</label>
                <select
                  value={billingTenant}
                  onChange={(e) => setBillingTenant(e.target.value)}
                  style={selectStyle}
                  required
                >
                  <option value="">Select tenant...</option>
                  {tenants.map((tenant: any) => (
                    <option key={tenant.id} value={tenant.id}>{tenant.name}</option>
                  ))}
                </select>
              </div>
              <div style={inputGroupStyle}>
                <label style={labelStyle}>Stripe Customer ID</label>
                <input
                  type="text"
                  value={billingStripeId}
                  onChange={(e) => setBillingStripeId(e.target.value)}
                  style={inputStyle}
                  placeholder="cus_abc123"
                />
              </div>
            </div>
            <div style={rowStyle}>
              <div style={inputGroupStyle}>
                <label style={labelStyle}>Tax ID (VAT/GST)</label>
                <input
                  type="text"
                  value={billingTaxId}
                  onChange={(e) => setBillingTaxId(e.target.value)}
                  style={inputStyle}
                  placeholder="VAT123456"
                />
              </div>
              <div style={inputGroupStyle}>
                <label style={labelStyle}>Credits Balance</label>
                <input
                  type="number"
                  value={billingCredits}
                  onChange={(e) => setBillingCredits(e.target.value)}
                  style={inputStyle}
                  min="0"
                />
              </div>
            </div>
            <button type="submit" style={buttonStyle}>Create Billing Account</button>
          </form>

          <h3 style={{ marginTop: "1.5rem" }}>All Billing Accounts</h3>
          {billingAccounts.length === 0 ? (
            <p style={{ color: "#888" }}>No billing accounts yet. Create tenants first.</p>
          ) : (
            billingAccounts.map((billing: any) => (
              <div key={billing.id} style={listItemStyle}>
                <span>
                  <strong>{billing.tenant_id?.name || "Unknown"}</strong>
                  {billing.stripe_customer_id && (
                    <span style={{ fontSize: "0.85rem", color: "#888", marginLeft: "0.5rem" }}>
                      Stripe: {billing.stripe_customer_id}
                    </span>
                  )}
                </span>
                <span style={badgeStyle("#4caf50")}>{billing.credits_balance} credits</span>
              </div>
            ))
          )}
        </div>
      )}

      {/* Workspaces Tab */}
      {activeTab === "workspaces" && (
        <div style={sectionStyle}>
          <h2>Workspaces</h2>
          <form onSubmit={handleCreateWorkspace} style={formStyle}>
            <div style={rowStyle}>
              <div style={inputGroupStyle}>
                <label style={labelStyle}>Name</label>
                <input
                  type="text"
                  value={workspaceName}
                  onChange={(e) => setWorkspaceName(e.target.value)}
                  style={inputStyle}
                  placeholder="Production"
                  required
                />
              </div>
              <div style={inputGroupStyle}>
                <label style={labelStyle}>Tenant (Controller)</label>
                <select
                  value={workspaceTenant}
                  onChange={(e) => setWorkspaceTenant(e.target.value)}
                  style={selectStyle}
                  required
                >
                  <option value="">Select tenant...</option>
                  {tenants.map((tenant: any) => (
                    <option key={tenant.id} value={tenant.id}>{tenant.name}</option>
                  ))}
                </select>
              </div>
              <div style={inputGroupStyle}>
                <label style={labelStyle}>Billing Account (Payer)</label>
                <select
                  value={workspaceBilling}
                  onChange={(e) => setWorkspaceBilling(e.target.value)}
                  style={selectStyle}
                  required
                >
                  <option value="">Select billing account...</option>
                  {billingAccounts.map((billing: any) => (
                    <option key={billing.id} value={billing.id}>
                      {billing.tenant_id?.name || "Unknown"} ({billing.credits_balance} credits)
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <button type="submit" style={buttonStyle}>Create Workspace</button>
          </form>

          <h3 style={{ marginTop: "1.5rem" }}>All Workspaces</h3>
          {workspaces.length === 0 ? (
            <p style={{ color: "#888" }}>No workspaces yet. Create tenants and billing accounts first.</p>
          ) : (
            workspaces.map((workspace: any) => (
              <div key={workspace.id} style={listItemStyle}>
                <span>
                  <strong>{workspace.name}</strong>
                  <span style={{ fontSize: "0.85rem", color: "#888", marginLeft: "0.5rem" }}>
                    controlled by {workspace.tenant_id?.name || "Unknown"},
                    paid by {workspace.billing_account_id?.tenant_id?.name || "Unknown"}
                  </span>
                </span>
              </div>
            ))
          )}

          {/* FindByTenant Demo */}
          {workspaceTenant && (
            <div style={{ marginTop: "1.5rem", padding: "1rem", background: "#1e1e1e", borderRadius: "4px" }}>
              <h4>findByTenant Demo</h4>
              <p style={{ color: "#888", fontSize: "0.85rem" }}>
                Workspaces for selected tenant: {multiTenancy.workspaceCollection.findByTenant(workspaceTenant).length}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
})
