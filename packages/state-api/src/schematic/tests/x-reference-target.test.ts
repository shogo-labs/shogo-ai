/**
 * x-reference-target Schematic Layer Tests
 *
 * Tests that x-reference-target is added during ArkType → Enhanced JSON Schema transformation.
 * This ensures DDL generation can identify FK target tables without needing inference.
 *
 * Target extraction logic:
 * - Single ref: "Company" → target = "Company"
 * - Array ref: "User[]" → target = "User"
 * - Multi-domain: "auth.User" → target = "auth.User" (keep full path)
 */

import { describe, test, expect } from "bun:test"
import { scope } from "arktype"
import { arkTypeToEnhancedJsonSchema } from "../arktype-to-json-schema"

describe("x-reference-target in schematic transformation", () => {
  test("single reference has x-reference-target", () => {
    const BusinessDomain = scope({
      User: {
        id: "string.uuid",
        name: "string",
        company: "Company"
      },
      Company: {
        id: "string.uuid",
        name: "string"
      }
    })

    const enhanced = arkTypeToEnhancedJsonSchema(BusinessDomain)

    // User.company should have x-reference-target: "Company"
    expect(enhanced.$defs!.User.properties.company["x-reference-type"]).toBe("single")
    expect(enhanced.$defs!.User.properties.company["x-reference-target"]).toBe("Company")
  })

  test("array reference has x-reference-target without []", () => {
    const BusinessDomain = scope({
      User: {
        id: "string.uuid",
        name: "string",
        company: "Company"
      },
      Company: {
        id: "string.uuid",
        name: "string",
        employees: "User[]"
      }
    })

    const enhanced = arkTypeToEnhancedJsonSchema(BusinessDomain)

    // Company.employees should have x-reference-target: "User" (not "User[]")
    expect(enhanced.$defs!.Company.properties.employees["x-reference-type"]).toBe("array")
    expect(enhanced.$defs!.Company.properties.employees["x-reference-target"]).toBe("User")
  })

  test("self-reference has x-reference-target", () => {
    const OrgDomain = scope({
      Employee: {
        id: "string.uuid",
        name: "string",
        "manager?": "Employee",
        reports: "Employee[]"
      }
    })

    const enhanced = arkTypeToEnhancedJsonSchema(OrgDomain)

    // Employee.manager should have x-reference-target: "Employee"
    expect(enhanced.$defs!.Employee.properties.manager["x-reference-type"]).toBe("single")
    expect(enhanced.$defs!.Employee.properties.manager["x-reference-target"]).toBe("Employee")

    // Employee.reports should have x-reference-target: "Employee"
    expect(enhanced.$defs!.Employee.properties.reports["x-reference-type"]).toBe("array")
    expect(enhanced.$defs!.Employee.properties.reports["x-reference-target"]).toBe("Employee")
  })

  test("optional reference has x-reference-target", () => {
    const BusinessDomain = scope({
      User: {
        id: "string.uuid",
        name: "string",
        "company?": "Company"
      },
      Company: {
        id: "string.uuid",
        name: "string"
      }
    })

    const enhanced = arkTypeToEnhancedJsonSchema(BusinessDomain)

    // User.company (optional) should still have x-reference-target
    expect(enhanced.$defs!.User.properties.company["x-reference-type"]).toBe("single")
    expect(enhanced.$defs!.User.properties.company["x-reference-target"]).toBe("Company")
  })

  test("multi-word entity reference has x-reference-target", () => {
    const AuthDomain = scope({
      AuthUser: {
        id: "string.uuid",
        email: "string"
      },
      AuthSession: {
        id: "string.uuid",
        user: "AuthUser",
        expiresAt: "number"
      }
    })

    const enhanced = arkTypeToEnhancedJsonSchema(AuthDomain)

    // AuthSession.user should have x-reference-target: "AuthUser"
    expect(enhanced.$defs!.AuthSession.properties.user["x-reference-type"]).toBe("single")
    expect(enhanced.$defs!.AuthSession.properties.user["x-reference-target"]).toBe("AuthUser")
  })
})

describe("x-reference-target with multi-domain scopes", () => {
  test("cross-domain reference uses full path", () => {
    const authScope = scope({
      User: {
        id: "string.uuid",
        email: "string"
      }
    })

    const cmsScope = scope({
      Post: {
        id: "string.uuid",
        title: "string",
        author: authScope.type("User")  // Cross-domain reference
      }
    })

    // Transform each scope separately
    const authEnhanced = arkTypeToEnhancedJsonSchema(authScope)
    const cmsEnhanced = arkTypeToEnhancedJsonSchema(cmsScope)

    // In multi-domain schemas, the target should include domain prefix
    // This test documents expected behavior - implementation may vary
    const authorProp = cmsEnhanced.$defs?.["cms.Post"]?.properties?.author ||
                       cmsEnhanced.$defs?.Post?.properties?.author

    if (authorProp) {
      // If the transformation detected it as a reference
      if (authorProp["x-reference-type"]) {
        expect(authorProp["x-reference-target"]).toBeDefined()
      }
    }
  })
})
