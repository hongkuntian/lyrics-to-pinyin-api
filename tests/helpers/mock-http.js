export function createMockReq({
  method = "POST",
  body = {},
  headers = { "content-type": "application/json" }
} = {}) {
  return {
    method,
    body,
    headers
  };
}

export function createMockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}
