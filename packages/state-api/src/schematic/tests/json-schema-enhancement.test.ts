import { describe, test, expect } from "bun:test";
import { scope, type } from "arktype";

// This import will fail initially (TDD)
import { arkTypeToEnhancedJsonSchema } from "../arktype-to-json-schema";

describe("ArkType to Enhanced JSON Schema", () => {
  test("preserves basic types and constraints", () => {
    // Given: Simple arkType with constraints
    const UserType = type({
      id: "string.uuid",
      name: "string >= 2",
      age: "number >= 18",
    });

    // When: Converting to enhanced JSON Schema
    const schema = arkTypeToEnhancedJsonSchema(UserType, "User");

    // Then: Basic JSON Schema is correct (normalized)
    expect(schema.type).toBe("object");
    expect(schema.properties?.id.type).toBe("string");
    expect(schema.properties?.id.format).toBe("uuid");
    expect(schema.properties?.id["x-mst-type"]).toBe("identifier");
    expect(schema.properties?.name.type).toBe("string");
    expect(schema.properties?.name.minLength).toBe(2);
    expect(schema.properties?.age.type).toBe("number");
    expect(schema.properties?.age.minimum).toBe(18);

    // And: arkType constraints are preserved in x-metadata
    expect(schema.properties?.id["x-arktype"]).toBe("string.uuid");
    expect(schema.properties?.name["x-arktype"]).toBe("string >= 2");
    expect(schema.properties?.age["x-arktype"]).toBe("number >= 18");
  });

  test("handles optional properties", () => {
    // Given: Type with optional properties
    const UserType = type({
      id: "string",
      "name?": "string",
      "age?": "number",
    });

    // When: Converting
    const schema = arkTypeToEnhancedJsonSchema(UserType, "User");

    // Then: Required array is correct
    expect(schema.required).toEqual(["id"]);
    expect(schema.required).not.toContain("name");
    expect(schema.required).not.toContain("age");
  });

  test("converts entity references to $ref", () => {
    // Given: Scope with entity references
    const Domain = scope({
      User: {
        id: "string.uuid",
        name: "string",
        company: "Company",
      },
      Company: {
        id: "string.uuid",
        name: "string",
      },
    });

    // When: Converting the User type
    const exported = Domain.export();
    const userSchema = arkTypeToEnhancedJsonSchema(exported.User, "User", {
      scope: Domain,
    });

    // Then: Reference becomes $ref
    expect(userSchema.properties?.company).toEqual({
      $ref: "#/$defs/Company",
      "x-reference-type": "single",
      "x-arktype": "Company",
    });
  });

  test("handles array references", () => {
    // Given: Type with array reference
    const Domain = scope({
      Company: {
        id: "string.uuid",
        name: "string",
        employees: "User[]",
      },
      User: {
        id: "string.uuid",
        name: "string",
      },
    });

    // When: Converting
    const exported = Domain.export();
    const companySchema = arkTypeToEnhancedJsonSchema(
      exported.Company,
      "Company",
      { scope: Domain }
    );

    // Then: Array reference uses $ref in items
    expect(companySchema.properties?.employees).toEqual({
      type: "array",
      items: {
        $ref: "#/$defs/User",
      },
      "x-reference-type": "array",
      "x-arktype": "User[]",
    });
  });

  test("preserves embedded arrays", () => {
    // Given: Type with embedded arrays
    const UserType = type({
      id: "string",
      tags: "string[]",
      scores: "number[]",
      addresses: [
        {
          street: "string",
          city: "string",
        },
      ],
    });

    // When: Converting
    const schema = arkTypeToEnhancedJsonSchema(UserType, "User");

    // Then: Primitive arrays are preserved
    expect(schema.properties?.tags).toEqual({
      type: "array",
      items: { type: "string" },
      "x-arktype": "string[]",
    });

    expect(schema.properties?.scores).toEqual({
      type: "array",
      items: { type: "number" },
      "x-arktype": "number[]",
    });

    // And: Object arrays are preserved with structure
    expect(schema.properties?.addresses.type).toBe("array");
    expect(schema.properties?.addresses.items.type).toBe("object");
    expect(schema.properties?.addresses.items.properties.street.type).toBe(
      "string"
    );
    expect(schema.properties?.addresses.items.properties.city.type).toBe(
      "string"
    );
  });

  test("handles union types", () => {
    // Given: Type with union
    const ContactType = type({
      id: "string",
      contactMethod: "'email' | 'phone' | 'mail'",
    });

    // When: Converting
    const schema = arkTypeToEnhancedJsonSchema(ContactType, "Contact");

    // Then: Union becomes enum
    expect(schema.properties?.contactMethod).toEqual({
      enum: ["email", "mail", "phone"],
      "x-arktype": "'email' | 'mail' | 'phone'",
    });
  });

  test("converts entire scope to definitions object", () => {
    // Given: Complete scope
    const Domain = scope({
      User: {
        id: "string.uuid",
        name: "string",
        company: "Company",
      },
      Company: {
        id: "string.uuid",
        name: "string",
        employees: "User[]",
      },
    });

    // When: Converting entire scope
    const schemaDocument = arkTypeToEnhancedJsonSchema(Domain);

    // Then: Creates proper JSON Schema document
    expect(schemaDocument.$schema).toBeTruthy();
    expect(schemaDocument.$defs).toBeDefined();
    expect(schemaDocument.$defs?.User).toBeDefined();
    expect(schemaDocument.$defs?.Company).toBeDefined();

    // And: References use proper paths
    expect(schemaDocument.$defs?.User.properties.company.$ref).toBe(
      "#/$defs/Company"
    );
    expect(schemaDocument.$defs?.Company.properties.employees.items.$ref).toBe(
      "#/$defs/User"
    );
  });

  test("adds x-computed hints for obvious computed arrays", () => {
    // Given: Scope with inverse relationship
    const Domain = scope({
      User: {
        id: "string.uuid",
        name: "string",
        company: "Company", // Single reference
      },
      Company: {
        id: "string.uuid",
        name: "string",
        employees: "User[]", // Array that could be computed
      },
    });

    // When: Converting with relationship hints
    const schemaDocument = arkTypeToEnhancedJsonSchema(Domain, {
      detectComputedArrays: true,
    });

    // Then: Adds x-computed hint
    expect(
      schemaDocument.$defs?.Company.properties.employees["x-computed"]
    ).toBe(true);
    expect(
      schemaDocument.$defs?.Company.properties.employees["x-inverse"]
    ).toBe("company");
  });
});
