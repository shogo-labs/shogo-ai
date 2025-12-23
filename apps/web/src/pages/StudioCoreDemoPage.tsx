/**
 * StudioCoreDemoPage - Proof of work page for Studio Core domain feature
 *
 * Demonstrates complete studio core functionality:
 * - Organization CRUD
 * - Project CRUD with tier and status fields
 * - Team creation with hierarchy (parent reference)
 * - Member creation with polymorphic binding (org/team/project)
 * - Member.level computed view
 * - Invitation with isExpired computed view
 * - Collection queries: findByUserId, findForResource
 * - Permission resolution
 * - Polymorphic validation error handling
 * - Data persistence across page refresh
 */

import { useState } from "react"
import { observer } from "mobx-react-lite"
import { useDomains } from "../contexts/DomainProvider"

// Styles
const containerStyle = {
  maxWidth: "1200px",
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

const successStyle = {
  padding: "0.75rem",
  borderRadius: "4px",
  background: "#4caf50",
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

const twoColumnStyle = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "1rem",
}

export const StudioCoreDemoPage = observer(function StudioCoreDemoPage() {
  const { studioCore } = useDomains()

  // Form state
  const [orgName, setOrgName] = useState("")
  const [orgSlug, setOrgSlug] = useState("")
  const [orgDescription, setOrgDescription] = useState("")
  const [projectName, setProjectName] = useState("")
  const [projectDescription, setProjectDescription] = useState("")
  const [projectTier, setProjectTier] = useState<string>("starter")
  const [projectStatus, setProjectStatus] = useState<string>("draft")
  const [selectedOrgId, setSelectedOrgId] = useState<string>("")
  const [teamName, setTeamName] = useState("")
  const [teamDescription, setTeamDescription] = useState("")
  const [teamParentId, setTeamParentId] = useState<string>("")
  const [memberUserId, setMemberUserId] = useState("")
  const [memberRole, setMemberRole] = useState<string>("member")
  const [memberTarget, setMemberTarget] = useState<string>("")
  const [inviteEmail, setInviteEmail] = useState("")
  const [inviteRole, setInviteRole] = useState<string>("member")
  const [inviteTarget, setInviteTarget] = useState<string>("")
  const [inviteExpiresDays, setInviteExpiresDays] = useState<number>(7)
  const [queryUserId, setQueryUserId] = useState("")
  const [permUserId, setPermUserId] = useState("")
  const [permResourceType, setPermResourceType] = useState<string>("organization")
  const [permResourceId, setPermResourceId] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // Data from store
  const organizations = studioCore.organizationCollection.all()
  const projects = studioCore.projectCollection.all()
  const teams = studioCore.teamCollection.all()
  const members = studioCore.memberCollection.all()
  const invitations = studioCore.invitationCollection.all()

  // Clear messages after a delay
  const showMessage = (type: "error" | "success", message: string) => {
    if (type === "error") {
      setError(message)
      setSuccess(null)
      setTimeout(() => setError(null), 5000)
    } else {
      setSuccess(message)
      setError(null)
      setTimeout(() => setSuccess(null), 5000)
    }
  }

  // Create organization
  const handleCreateOrg = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const newOrg = await studioCore.organizationCollection.insertOne({
        id: crypto.randomUUID(),
        name: orgName,
        slug: orgSlug,
        description: orgDescription || undefined,
        createdAt: Date.now(),
      })
      showMessage("success", `Created organization: ${newOrg.name}`)
      setOrgName("")
      setOrgSlug("")
      setOrgDescription("")
    } catch (err: any) {
      showMessage("error", err.message || "Failed to create organization")
    }
  }

  // Update organization
  const handleUpdateOrg = async (orgId: string, field: string, value: string) => {
    try {
      await studioCore.organizationCollection.updateOne(orgId, { [field]: value })
      showMessage("success", `Updated organization ${field}`)
    } catch (err: any) {
      showMessage("error", err.message || `Failed to update organization ${field}`)
    }
  }

  // Create project
  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedOrgId) {
      showMessage("error", "Please select an organization")
      return
    }
    try {
      const newProject = await studioCore.projectCollection.insertOne({
        id: crypto.randomUUID(),
        name: projectName,
        description: projectDescription || undefined,
        organization: selectedOrgId,
        tier: projectTier,
        status: projectStatus,
        createdAt: Date.now(),
      })
      showMessage("success", `Created project: ${newProject.name}`)
      setProjectName("")
      setProjectDescription("")
      setProjectTier("starter")
      setProjectStatus("draft")
    } catch (err: any) {
      showMessage("error", err.message || "Failed to create project")
    }
  }

  // Create team
  const handleCreateTeam = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedOrgId) {
      showMessage("error", "Please select an organization")
      return
    }
    try {
      const newTeam = await studioCore.teamCollection.insertOne({
        id: crypto.randomUUID(),
        name: teamName,
        description: teamDescription || undefined,
        organization: selectedOrgId,
        parent: teamParentId || undefined,
        createdAt: Date.now(),
      })
      showMessage("success", `Created team: ${newTeam.name}`)
      setTeamName("")
      setTeamDescription("")
      setTeamParentId("")
    } catch (err: any) {
      showMessage("error", err.message || "Failed to create team")
    }
  }

  // Create member (with polymorphic validation)
  const handleCreateMember = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!memberTarget) {
      showMessage("error", "Please select a target (organization, team, or project)")
      return
    }
    try {
      const [targetType, targetId] = memberTarget.split(":")
      const memberData: any = {
        id: crypto.randomUUID(),
        userId: memberUserId,
        role: memberRole,
        createdAt: Date.now(),
      }

      // Set the appropriate reference field
      if (targetType === "org") {
        memberData.organization = targetId
      } else if (targetType === "team") {
        memberData.team = targetId
      } else if (targetType === "project") {
        memberData.project = targetId
      }

      // Polymorphic validation: exactly one of org/team/project must be set
      const resourceCount = [memberData.organization, memberData.team, memberData.project].filter(Boolean).length
      if (resourceCount !== 1) {
        throw new Error("Member must have exactly one of: organization, team, or project")
      }

      const newMember = await studioCore.memberCollection.insertOne(memberData)
      showMessage("success", `Created member: ${newMember.userId} with level ${newMember.level}`)
      setMemberUserId("")
      setMemberRole("member")
      setMemberTarget("")
    } catch (err: any) {
      showMessage("error", err.message || "Failed to create member")
    }
  }

  // Create invitation
  const handleCreateInvitation = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!inviteTarget) {
      showMessage("error", "Please select a target (organization, team, or project)")
      return
    }
    try {
      const [targetType, targetId] = inviteTarget.split(":")
      const inviteData: any = {
        id: crypto.randomUUID(),
        email: inviteEmail,
        role: inviteRole,
        status: "pending",
        expiresAt: Date.now() + inviteExpiresDays * 24 * 60 * 60 * 1000,
        createdAt: Date.now(),
      }

      // Set the appropriate reference field
      if (targetType === "org") {
        inviteData.organization = targetId
      } else if (targetType === "team") {
        inviteData.team = targetId
      } else if (targetType === "project") {
        inviteData.project = targetId
      }

      // Polymorphic validation: exactly one of org/team/project must be set
      const resourceCount = [inviteData.organization, inviteData.team, inviteData.project].filter(Boolean).length
      if (resourceCount !== 1) {
        throw new Error("Invitation must have exactly one of: organization, team, or project")
      }

      const newInvite = await studioCore.invitationCollection.insertOne(inviteData)
      showMessage("success", `Created invitation for ${newInvite.email}`)
      setInviteEmail("")
      setInviteRole("member")
      setInviteTarget("")
      setInviteExpiresDays(7)
    } catch (err: any) {
      showMessage("error", err.message || "Failed to create invitation")
    }
  }

  // Query members by user ID
  const handleQueryByUser = () => {
    if (!queryUserId) {
      showMessage("error", "Please enter a user ID")
      return
    }
    const userMembers = studioCore.memberCollection.findByUserId(queryUserId)
    showMessage("success", `Found ${userMembers.length} memberships for user ${queryUserId}`)
  }

  // Resolve permissions
  const handleResolvePermissions = () => {
    if (!permUserId || !permResourceId) {
      showMessage("error", "Enter user ID and resource ID")
      return
    }
    try {
      const effectiveRole = studioCore.resolvePermissions(
        permUserId,
        permResourceType as "organization" | "team" | "project",
        permResourceId
      )
      if (effectiveRole) {
        showMessage("success", `Effective role for ${permUserId}: ${effectiveRole}`)
      } else {
        showMessage("success", `No permissions found for ${permUserId}`)
      }
    } catch (err: any) {
      showMessage("error", err.message || "Failed to resolve permissions")
    }
  }

  // Test polymorphic validation error
  const handleTestPolymorphicError = () => {
    try {
      // Try to create member with zero refs (should fail)
      studioCore.createMember({
        id: crypto.randomUUID(),
        userId: "test-user",
        role: "member",
        createdAt: Date.now(),
      })
    } catch (err: any) {
      showMessage("error", `Validation working: ${err.message}`)
    }
  }

  return (
    <div style={containerStyle}>
      <h1>Studio Core Demo</h1>
      <p style={{ color: "#888", marginBottom: "2rem" }}>
        Demonstrates Organization, Project, Team, Member, and Invitation management with
        computed views, collection queries, and permission resolution.
      </p>

      {error && <div style={errorStyle} data-testid="error-message">{error}</div>}
      {success && <div style={successStyle} data-testid="success-message">{success}</div>}

      {/* Organizations */}
      <div style={sectionStyle} data-testid="organizations-section">
        <h2>Organizations ({organizations.length})</h2>

        <form onSubmit={handleCreateOrg} style={formStyle}>
          <div style={twoColumnStyle}>
            <div style={inputGroupStyle}>
              <label htmlFor="org-name" style={labelStyle}>Organization Name</label>
              <input
                id="org-name"
                type="text"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                style={inputStyle}
                placeholder="Acme Inc"
                required
              />
            </div>

            <div style={inputGroupStyle}>
              <label htmlFor="org-slug" style={labelStyle}>Slug</label>
              <input
                id="org-slug"
                type="text"
                value={orgSlug}
                onChange={(e) => setOrgSlug(e.target.value)}
                style={inputStyle}
                placeholder="acme"
                required
              />
            </div>
          </div>

          <div style={inputGroupStyle}>
            <label htmlFor="org-description" style={labelStyle}>Description (optional)</label>
            <input
              id="org-description"
              type="text"
              value={orgDescription}
              onChange={(e) => setOrgDescription(e.target.value)}
              style={inputStyle}
              placeholder="Description"
            />
          </div>

          <button type="submit" style={buttonStyle}>Create Organization</button>
        </form>

        {organizations.length > 0 && (
          <div style={{ marginTop: "1.5rem" }}>
            <h3>Existing Organizations</h3>
            {organizations.map((org: any) => (
              <div key={org.id} style={listItemStyle}>
                <div>
                  <strong>{org.name}</strong> ({org.slug})
                  {org.description && <div style={{ fontSize: "0.85rem", color: "#999" }}>{org.description}</div>}
                  <div style={{ fontSize: "0.75rem", color: "#666" }}>ID: {org.id.slice(0, 8)}...</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Projects */}
      <div style={sectionStyle} data-testid="projects-section">
        <h2>Projects ({projects.length})</h2>

        <form onSubmit={handleCreateProject} style={formStyle}>
          <div style={inputGroupStyle}>
            <label htmlFor="project-org" style={labelStyle}>Organization</label>
            <select
              id="project-org"
              value={selectedOrgId}
              onChange={(e) => setSelectedOrgId(e.target.value)}
              style={selectStyle}
              required
            >
              <option value="">Select organization...</option>
              {organizations.map((org: any) => (
                <option key={org.id} value={org.id}>{org.name}</option>
              ))}
            </select>
          </div>

          <div style={twoColumnStyle}>
            <div style={inputGroupStyle}>
              <label htmlFor="project-name" style={labelStyle}>Project Name</label>
              <input
                id="project-name"
                type="text"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                style={inputStyle}
                placeholder="My Project"
                required
              />
            </div>

            <div style={inputGroupStyle}>
              <label htmlFor="project-tier" style={labelStyle}>Tier</label>
              <select
                id="project-tier"
                value={projectTier}
                onChange={(e) => setProjectTier(e.target.value)}
                style={selectStyle}
              >
                <option value="starter">Starter</option>
                <option value="pro">Pro</option>
                <option value="enterprise">Enterprise</option>
                <option value="internal">Internal</option>
              </select>
            </div>
          </div>

          <div style={twoColumnStyle}>
            <div style={inputGroupStyle}>
              <label htmlFor="project-status" style={labelStyle}>Status</label>
              <select
                id="project-status"
                value={projectStatus}
                onChange={(e) => setProjectStatus(e.target.value)}
                style={selectStyle}
              >
                <option value="draft">Draft</option>
                <option value="active">Active</option>
                <option value="archived">Archived</option>
              </select>
            </div>

            <div style={inputGroupStyle}>
              <label htmlFor="project-description" style={labelStyle}>Description (optional)</label>
              <input
                id="project-description"
                type="text"
                value={projectDescription}
                onChange={(e) => setProjectDescription(e.target.value)}
                style={inputStyle}
                placeholder="Project description"
              />
            </div>
          </div>

          <button type="submit" style={buttonStyle}>Create Project</button>
        </form>

        {projects.length > 0 && (
          <div style={{ marginTop: "1.5rem" }}>
            <h3>Existing Projects</h3>
            {projects.map((project: any) => (
              <div key={project.id} style={listItemStyle}>
                <div>
                  <strong>{project.name}</strong>
                  <div style={{ fontSize: "0.85rem", color: "#999" }}>
                    Org: {project.organization?.name} | Tier: {project.tier} | Status: {project.status}
                  </div>
                  {project.description && <div style={{ fontSize: "0.85rem", color: "#999" }}>{project.description}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Teams */}
      <div style={sectionStyle} data-testid="teams-section">
        <h2>Teams ({teams.length})</h2>

        <form onSubmit={handleCreateTeam} style={formStyle}>
          <div style={inputGroupStyle}>
            <label htmlFor="team-org" style={labelStyle}>Organization</label>
            <select
              id="team-org"
              value={selectedOrgId}
              onChange={(e) => setSelectedOrgId(e.target.value)}
              style={selectStyle}
              required
            >
              <option value="">Select organization...</option>
              {organizations.map((org: any) => (
                <option key={org.id} value={org.id}>{org.name}</option>
              ))}
            </select>
          </div>

          <div style={twoColumnStyle}>
            <div style={inputGroupStyle}>
              <label htmlFor="team-name" style={labelStyle}>Team Name</label>
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
              <label htmlFor="team-parent" style={labelStyle}>Parent Team (optional)</label>
              <select
                id="team-parent"
                value={teamParentId}
                onChange={(e) => setTeamParentId(e.target.value)}
                style={selectStyle}
              >
                <option value="">None (root team)</option>
                {teams.map((team: any) => (
                  <option key={team.id} value={team.id}>{team.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div style={inputGroupStyle}>
            <label htmlFor="team-description" style={labelStyle}>Description (optional)</label>
            <input
              id="team-description"
              type="text"
              value={teamDescription}
              onChange={(e) => setTeamDescription(e.target.value)}
              style={inputStyle}
              placeholder="Team description"
            />
          </div>

          <button type="submit" style={buttonStyle}>Create Team</button>
        </form>

        {teams.length > 0 && (
          <div style={{ marginTop: "1.5rem" }}>
            <h3>Existing Teams</h3>
            {teams.map((team: any) => (
              <div key={team.id} style={listItemStyle}>
                <div>
                  <strong>{team.name}</strong>
                  <div style={{ fontSize: "0.85rem", color: "#999" }}>
                    Org: {team.organization?.name}
                    {team.parent && ` | Parent: ${team.parent.name}`}
                  </div>
                  {team.description && <div style={{ fontSize: "0.85rem", color: "#999" }}>{team.description}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Members */}
      <div style={sectionStyle} data-testid="members-section">
        <h2>Members ({members.length})</h2>

        <form onSubmit={handleCreateMember} style={formStyle}>
          <div style={twoColumnStyle}>
            <div style={inputGroupStyle}>
              <label htmlFor="member-user-id" style={labelStyle}>User ID</label>
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
              <label htmlFor="member-role" style={labelStyle}>Role</label>
              <select
                id="member-role"
                value={memberRole}
                onChange={(e) => setMemberRole(e.target.value)}
                style={selectStyle}
              >
                <option value="owner">Owner (level 40)</option>
                <option value="admin">Admin (level 30)</option>
                <option value="member">Member (level 20)</option>
                <option value="viewer">Viewer (level 10)</option>
              </select>
            </div>
          </div>

          <div style={inputGroupStyle}>
            <label htmlFor="member-target" style={labelStyle}>Target</label>
            <select
              id="member-target"
              value={memberTarget}
              onChange={(e) => setMemberTarget(e.target.value)}
              style={selectStyle}
              required
            >
              <option value="">Select target...</option>
              <optgroup label="Organizations">
                {organizations.map((org: any) => (
                  <option key={org.id} value={`org:${org.id}`}>{org.name}</option>
                ))}
              </optgroup>
              <optgroup label="Teams">
                {teams.map((team: any) => (
                  <option key={team.id} value={`team:${team.id}`}>{team.name}</option>
                ))}
              </optgroup>
              <optgroup label="Projects">
                {projects.map((project: any) => (
                  <option key={project.id} value={`project:${project.id}`}>{project.name}</option>
                ))}
              </optgroup>
            </select>
          </div>

          <div style={{ display: "flex", gap: "1rem" }}>
            <button type="submit" style={buttonStyle}>Create Member</button>
            <button type="button" onClick={handleTestPolymorphicError} style={secondaryButtonStyle}>
              Test Polymorphic Validation
            </button>
          </div>
        </form>

        {members.length > 0 && (
          <div style={{ marginTop: "1.5rem" }}>
            <h3>Existing Members</h3>
            {members.map((member: any) => (
              <div key={member.id} style={listItemStyle}>
                <div>
                  <strong>{member.userId}</strong> - {member.role} (level: {member.level})
                  <div style={{ fontSize: "0.85rem", color: "#999" }}>
                    {member.organization && `Org: ${member.organization.name}`}
                    {member.team && `Team: ${member.team.name}`}
                    {member.project && `Project: ${member.project.name}`}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Invitations */}
      <div style={sectionStyle} data-testid="invitations-section">
        <h2>Invitations ({invitations.length})</h2>

        <form onSubmit={handleCreateInvitation} style={formStyle}>
          <div style={twoColumnStyle}>
            <div style={inputGroupStyle}>
              <label htmlFor="invite-email" style={labelStyle}>Email</label>
              <input
                id="invite-email"
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                style={inputStyle}
                placeholder="user@example.com"
                required
              />
            </div>

            <div style={inputGroupStyle}>
              <label htmlFor="invite-role" style={labelStyle}>Role</label>
              <select
                id="invite-role"
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value)}
                style={selectStyle}
              >
                <option value="owner">Owner</option>
                <option value="admin">Admin</option>
                <option value="member">Member</option>
                <option value="viewer">Viewer</option>
              </select>
            </div>
          </div>

          <div style={twoColumnStyle}>
            <div style={inputGroupStyle}>
              <label htmlFor="invite-target" style={labelStyle}>Target</label>
              <select
                id="invite-target"
                value={inviteTarget}
                onChange={(e) => setInviteTarget(e.target.value)}
                style={selectStyle}
                required
              >
                <option value="">Select target...</option>
                <optgroup label="Organizations">
                  {organizations.map((org: any) => (
                    <option key={org.id} value={`org:${org.id}`}>{org.name}</option>
                  ))}
                </optgroup>
                <optgroup label="Teams">
                  {teams.map((team: any) => (
                    <option key={team.id} value={`team:${team.id}`}>{team.name}</option>
                  ))}
                </optgroup>
                <optgroup label="Projects">
                  {projects.map((project: any) => (
                    <option key={project.id} value={`project:${project.id}`}>{project.name}</option>
                  ))}
                </optgroup>
              </select>
            </div>

            <div style={inputGroupStyle}>
              <label htmlFor="invite-expires" style={labelStyle}>Expires In (days)</label>
              <input
                id="invite-expires"
                type="number"
                value={inviteExpiresDays}
                onChange={(e) => setInviteExpiresDays(Number(e.target.value))}
                style={inputStyle}
                min="1"
                max="365"
              />
            </div>
          </div>

          <button type="submit" style={buttonStyle}>Create Invitation</button>
        </form>

        {invitations.length > 0 && (
          <div style={{ marginTop: "1.5rem" }}>
            <h3>Existing Invitations</h3>
            {invitations.map((invite: any) => (
              <div key={invite.id} style={listItemStyle}>
                <div>
                  <strong>{invite.email}</strong> - {invite.role}
                  <div style={{ fontSize: "0.85rem", color: "#999" }}>
                    Status: {invite.status} | Expired: {invite.isExpired ? "Yes" : "No"}
                    {invite.organization && ` | Org: ${invite.organization.name}`}
                    {invite.team && ` | Team: ${invite.team.name}`}
                    {invite.project && ` | Project: ${invite.project.name}`}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Collection Queries */}
      <div style={sectionStyle} data-testid="queries-section">
        <h2>Collection Queries</h2>

        <div style={formStyle}>
          <div style={inputGroupStyle}>
            <label htmlFor="query-user-id" style={labelStyle}>Find Memberships by User ID</label>
            <div style={{ display: "flex", gap: "1rem" }}>
              <input
                id="query-user-id"
                type="text"
                value={queryUserId}
                onChange={(e) => setQueryUserId(e.target.value)}
                style={{ ...inputStyle, flex: 1 }}
                placeholder="user-123"
              />
              <button type="button" onClick={handleQueryByUser} style={buttonStyle}>
                Query
              </button>
            </div>
          </div>

          {queryUserId && (
            <div style={{ marginTop: "1rem" }}>
              <h3>Results for {queryUserId}:</h3>
              {studioCore.memberCollection.findByUserId(queryUserId).map((member: any) => (
                <div key={member.id} style={listItemStyle}>
                  {member.role} (level {member.level})
                  {member.organization && ` @ Org: ${member.organization.name}`}
                  {member.team && ` @ Team: ${member.team.name}`}
                  {member.project && ` @ Project: ${member.project.name}`}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Permission Resolution */}
      <div style={sectionStyle} data-testid="permissions-section">
        <h2>Permission Resolution Demo</h2>
        <p style={{ color: "#888", marginBottom: "1rem" }}>
          Test how permissions cascade from organization to team to project
        </p>

        <div style={formStyle}>
          <div style={twoColumnStyle}>
            <div style={inputGroupStyle}>
              <label htmlFor="perm-user-id" style={labelStyle}>User ID</label>
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
              <label htmlFor="perm-resource-type" style={labelStyle}>Resource Type</label>
              <select
                id="perm-resource-type"
                value={permResourceType}
                onChange={(e) => setPermResourceType(e.target.value)}
                style={selectStyle}
              >
                <option value="organization">Organization</option>
                <option value="team">Team</option>
                <option value="project">Project</option>
              </select>
            </div>
          </div>

          <div style={inputGroupStyle}>
            <label htmlFor="perm-resource-id" style={labelStyle}>Resource</label>
            <select
              id="perm-resource-id"
              value={permResourceId}
              onChange={(e) => setPermResourceId(e.target.value)}
              style={selectStyle}
            >
              <option value="">Select resource...</option>
              {permResourceType === "organization" &&
                organizations.map((org: any) => (
                  <option key={org.id} value={org.id}>{org.name}</option>
                ))}
              {permResourceType === "team" &&
                teams.map((team: any) => (
                  <option key={team.id} value={team.id}>{team.name}</option>
                ))}
              {permResourceType === "project" &&
                projects.map((project: any) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
            </select>
          </div>

          <button type="button" onClick={handleResolvePermissions} style={buttonStyle}>
            Check Permissions
          </button>
        </div>
      </div>
    </div>
  )
})
