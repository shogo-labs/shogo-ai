/**
 * TeamsDemoPage - Proof of work page for Teams domain feature
 *
 * Demonstrates complete teams management:
 * - Organization CRUD
 * - Team hierarchy (nested teams)
 * - Membership management
 * - Permission resolution across hierarchy
 */

import { useState } from "react"
import { observer } from "mobx-react-lite"
import { useTeams } from "../contexts/TeamsContext"

// Styles
const containerStyle = {
  maxWidth: "900px",
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

const inputGroupStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.5rem",
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

const secondaryButtonStyle = {
  ...buttonStyle,
  background: "#666",
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

const hierarchyIndent = (level: number) => ({
  marginLeft: `${level * 1.5}rem`,
  borderLeft: level > 0 ? "2px solid #444" : "none",
  paddingLeft: level > 0 ? "0.75rem" : "0",
})

export const TeamsDemoPage = observer(function TeamsDemoPage() {
  const teams = useTeams()

  // Form state
  const [orgName, setOrgName] = useState("")
  const [orgSlug, setOrgSlug] = useState("")
  const [teamName, setTeamName] = useState("")
  const [parentTeamId, setParentTeamId] = useState<string>("")
  const [memberUserId, setMemberUserId] = useState("")
  const [memberRole, setMemberRole] = useState<string>("member")
  const [memberTarget, setMemberTarget] = useState<string>("")
  const [permUserId, setPermUserId] = useState("")
  const [permResourceType, setPermResourceType] = useState<string>("organization")
  const [permResourceId, setPermResourceId] = useState("")
  const [error, setError] = useState<string | null>(null)

  // Data from store
  const organizations = teams.organizationCollection.all()
  const allTeams = teams.teamCollection.all()
  const memberships = teams.membershipCollection.all()
  const currentOrg = organizations[0]

  // Create organization
  const handleCreateOrg = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    try {
      teams.organizationCollection.add({
        id: crypto.randomUUID(),
        name: orgName,
        slug: orgSlug,
        createdAt: Date.now(),
      })
      setOrgName("")
      setOrgSlug("")
    } catch (err: any) {
      setError(err.message || "Failed to create organization")
    }
  }

  // Create team
  const handleCreateTeam = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (!currentOrg) {
      setError("Create an organization first")
      return
    }

    try {
      teams.teamCollection.add({
        id: crypto.randomUUID(),
        name: teamName,
        organizationId: currentOrg.id,
        parentId: parentTeamId || undefined,
        createdAt: Date.now(),
      })
      setTeamName("")
      setParentTeamId("")
    } catch (err: any) {
      setError(err.message || "Failed to create team")
    }
  }

  // Add membership
  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (!memberTarget) {
      setError("Select an organization or team")
      return
    }

    try {
      const [targetType, targetId] = memberTarget.split(":")
      teams.membershipCollection.add({
        id: crypto.randomUUID(),
        userId: memberUserId,
        role: memberRole,
        organizationId: targetType === "org" ? targetId : undefined,
        teamId: targetType === "team" ? targetId : undefined,
        createdAt: Date.now(),
      })
      setMemberUserId("")
      setMemberRole("member")
    } catch (err: any) {
      setError(err.message || "Failed to add member")
    }
  }

  // Resolve permissions
  const handleResolvePermissions = () => {
    setError(null)

    if (!permUserId || !permResourceId) {
      setError("Enter user ID and resource ID")
      return
    }

    try {
      const effectiveRole = teams.resolvePermissions(
        permUserId,
        permResourceType as "organization" | "team" | "app",
        permResourceId
      )
      alert(`Effective role for ${permUserId}: ${effectiveRole || "No permissions"}`)
    } catch (err: any) {
      setError(err.message || "Failed to resolve permissions")
    }
  }

  // Build team hierarchy for display
  const getTeamHierarchy = (parentId?: string, level = 0): Array<{ team: any; level: number }> => {
    const children = allTeams.filter((t: any) =>
      parentId ? t.parentId?.id === parentId : !t.parentId
    )
    const result: Array<{ team: any; level: number }> = []
    for (const team of children) {
      result.push({ team, level })
      result.push(...getTeamHierarchy(team.id, level + 1))
    }
    return result
  }

  // No organization yet - show create form
  if (!currentOrg) {
    return (
      <div style={containerStyle}>
        <h1>Teams Demo</h1>

        {error && <div style={errorStyle} data-testid="error-message">{error}</div>}

        <div style={sectionStyle} data-testid="create-org-form">
          <h2>Create Organization</h2>
          <form onSubmit={handleCreateOrg} style={formStyle}>
            <div style={inputGroupStyle}>
              <label htmlFor="org-name" style={labelStyle}>
                Organization Name
              </label>
              <input
                id="org-name"
                type="text"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                style={inputStyle}
                placeholder="My Organization"
                required
              />
            </div>

            <div style={inputGroupStyle}>
              <label htmlFor="org-slug" style={labelStyle}>
                Slug
              </label>
              <input
                id="org-slug"
                type="text"
                value={orgSlug}
                onChange={(e) => setOrgSlug(e.target.value)}
                style={inputStyle}
                placeholder="my-org"
                required
              />
            </div>

            <button type="submit" style={buttonStyle}>
              Create Organization
            </button>
          </form>
        </div>
      </div>
    )
  }

  // Organization exists - show full UI
  const teamHierarchy = getTeamHierarchy()

  return (
    <div style={containerStyle}>
      <h1>Teams Demo</h1>

      {error && <div style={errorStyle} data-testid="error-message">{error}</div>}

      {/* Organization Details */}
      <div style={sectionStyle} data-testid="org-details">
        <h2>Organization</h2>
        <p><strong>Name:</strong> {currentOrg.name}</p>
        <p><strong>Slug:</strong> {currentOrg.slug}</p>
        <p style={{ fontSize: "0.8rem", color: "#888" }}>ID: {currentOrg.id}</p>
      </div>

      {/* Create Team */}
      <div style={sectionStyle} data-testid="create-team-form">
        <h2>Create Team</h2>
        <form onSubmit={handleCreateTeam} style={formStyle}>
          <div style={inputGroupStyle}>
            <label htmlFor="team-name" style={labelStyle}>
              Team Name
            </label>
            <input
              id="team-name"
              type="text"
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
              style={inputStyle}
              placeholder="Engineering"
              required
            />
          </div>

          <div style={inputGroupStyle}>
            <label htmlFor="parent-team" style={labelStyle}>
              Parent Team (optional)
            </label>
            <select
              id="parent-team"
              value={parentTeamId}
              onChange={(e) => setParentTeamId(e.target.value)}
              style={selectStyle}
              data-testid="parent-team-selector"
            >
              <option value="">None (root team)</option>
              {allTeams.map((team: any) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
          </div>

          <button type="submit" style={buttonStyle}>
            Create Team
          </button>
        </form>
      </div>

      {/* Team Hierarchy */}
      <div style={sectionStyle} data-testid="teams-list">
        <h2>Teams ({allTeams.length})</h2>
        {teamHierarchy.length === 0 ? (
          <p style={{ color: "#888" }}>No teams yet. Create one above.</p>
        ) : (
          <div>
            {teamHierarchy.map(({ team, level }) => (
              <div key={team.id} style={{ ...listItemStyle, ...hierarchyIndent(level) }}>
                <span>
                  {team.name}
                  <span style={{ fontSize: "0.8rem", color: "#888", marginLeft: "0.5rem" }}>
                    ({team.id.slice(0, 8)}...)
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Membership Management */}
      <div style={sectionStyle} data-testid="membership-section">
        <h2>Add Member</h2>
        <form onSubmit={handleAddMember} style={formStyle}>
          <div style={inputGroupStyle}>
            <label htmlFor="member-user-id" style={labelStyle}>
              User ID
            </label>
            <input
              id="member-user-id"
              type="text"
              value={memberUserId}
              onChange={(e) => setMemberUserId(e.target.value)}
              style={inputStyle}
              placeholder="user-123"
              required
            />
          </div>

          <div style={inputGroupStyle}>
            <label htmlFor="member-role" style={labelStyle}>
              Role
            </label>
            <select
              id="member-role"
              value={memberRole}
              onChange={(e) => setMemberRole(e.target.value)}
              style={selectStyle}
            >
              <option value="owner">Owner</option>
              <option value="admin">Admin</option>
              <option value="member">Member</option>
              <option value="viewer">Viewer</option>
            </select>
          </div>

          <div style={inputGroupStyle}>
            <label htmlFor="member-target" style={labelStyle}>
              Add to
            </label>
            <select
              id="member-target"
              value={memberTarget}
              onChange={(e) => setMemberTarget(e.target.value)}
              style={selectStyle}
              required
            >
              <option value="">Select...</option>
              <option value={`org:${currentOrg.id}`}>Organization: {currentOrg.name}</option>
              {allTeams.map((team: any) => (
                <option key={team.id} value={`team:${team.id}`}>
                  Team: {team.name}
                </option>
              ))}
            </select>
          </div>

          <button type="submit" style={buttonStyle}>
            Add Member
          </button>
        </form>

        <h3 style={{ marginTop: "1.5rem" }}>Current Memberships ({memberships.length})</h3>
        {memberships.length === 0 ? (
          <p style={{ color: "#888" }}>No memberships yet.</p>
        ) : (
          <div>
            {memberships.map((m: any) => (
              <div key={m.id} style={listItemStyle}>
                <span>
                  <strong>{m.userId}</strong> - {m.role}
                  {m.organizationId && ` @ Org`}
                  {m.teamId && ` @ Team: ${m.teamId.name}`}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Permission Resolution Demo */}
      <div style={sectionStyle} data-testid="permission-demo">
        <h2>Permission Resolution Demo</h2>
        <p style={{ color: "#888", marginBottom: "1rem" }}>
          Test how permissions cascade from organization → team → sub-team
        </p>

        <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
          <div style={inputGroupStyle}>
            <label htmlFor="perm-user-id" style={labelStyle}>
              User ID
            </label>
            <input
              id="perm-user-id"
              type="text"
              value={permUserId}
              onChange={(e) => setPermUserId(e.target.value)}
              style={inputStyle}
              placeholder="user-123"
            />
          </div>

          <div style={inputGroupStyle}>
            <label htmlFor="perm-resource-type" style={labelStyle}>
              Resource Type
            </label>
            <select
              id="perm-resource-type"
              value={permResourceType}
              onChange={(e) => setPermResourceType(e.target.value)}
              style={selectStyle}
            >
              <option value="organization">Organization</option>
              <option value="team">Team</option>
            </select>
          </div>

          <div style={inputGroupStyle}>
            <label htmlFor="perm-resource-id" style={labelStyle}>
              Resource
            </label>
            <select
              id="perm-resource-id"
              value={permResourceId}
              onChange={(e) => setPermResourceId(e.target.value)}
              style={selectStyle}
            >
              <option value="">Select...</option>
              {permResourceType === "organization" && (
                <option value={currentOrg.id}>{currentOrg.name}</option>
              )}
              {permResourceType === "team" &&
                allTeams.map((team: any) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
            </select>
          </div>

          <div style={{ display: "flex", alignItems: "flex-end" }}>
            <button type="button" onClick={handleResolvePermissions} style={secondaryButtonStyle}>
              Check Permissions
            </button>
          </div>
        </div>
      </div>
    </div>
  )
})
