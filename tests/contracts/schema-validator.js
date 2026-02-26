function typeMatches(expectedType, value) {
  if (expectedType === "null") {
    return value === null;
  }
  if (expectedType === "array") {
    return Array.isArray(value);
  }
  if (expectedType === "object") {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  return typeof value === expectedType;
}

export function validateSchema(schema, value, path = "$") {
  const errors = [];

  if (schema.anyOf) {
    const branchMatched = schema.anyOf.some((branch) => validateSchema(branch, value, path).length === 0);
    if (!branchMatched) {
      errors.push(`${path}: does not satisfy anyOf`);
    }
    return errors;
  }

  if (schema.type && !typeMatches(schema.type, value)) {
    errors.push(`${path}: expected ${schema.type}`);
    return errors;
  }

  if (schema.type === "object") {
    const required = schema.required || [];
    for (const key of required) {
      if (!(key in value)) {
        errors.push(`${path}.${key}: missing required property`);
      }
    }

    const properties = schema.properties || {};
    for (const [key, propSchema] of Object.entries(properties)) {
      if (key in value && propSchema && Object.keys(propSchema).length > 0) {
        errors.push(...validateSchema(propSchema, value[key], `${path}.${key}`));
      }
    }
  }

  if (schema.type === "array" && schema.items) {
    for (let i = 0; i < value.length; i += 1) {
      errors.push(...validateSchema(schema.items, value[i], `${path}[${i}]`));
    }
  }

  return errors;
}
