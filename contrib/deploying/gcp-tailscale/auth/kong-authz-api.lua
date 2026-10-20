-- Kong requires HQ's authz_api claim on Supabase's API routes (HQ plan 0006B, B8).
--
-- authz_api_claim.py renders this into kong.yml as a sandboxed pre-function on
-- every service that forwards to PostgREST, Storage, Realtime or the edge
-- runtime, prefixed with `local REQUIRED = "<api resource>"`. GoTrue's routes
-- carry no copy: they issue and refresh the tokens.
--
-- Every credential those upstreams read is checked: the Authorization bearer,
-- the apikey and x-api-key headers, and the apikey query argument (Realtime's
-- socket), each value of each. A token GoTrue issued (it always carries a
-- session_id) must list REQUIRED in its top-level authz_api array, which only
-- GoTrue's access-token hook writes, never from user metadata. Tokens that keep
-- today's access (0006B Q5): anon, service_role, and the short user-scoped
-- tokens Carbon's own server signs with the JWT secret (no session_id), which
-- never leave that server. A credential that is not a JWT is refused, so no
-- form an upstream might still parse can skip the check.
--
-- Kong does not hold the JWT secret or verify signatures: PostgREST, Storage,
-- Realtime and the fork's edge dispatcher each verify the same token, so a
-- token whose claims were edited is refused there.
local cjson = require("cjson.safe")

local OPEN_ROLES = { anon = true, service_role = true }
local HEADERS = { "authorization", "apikey", "x-api-key" }
local MESSAGES = {
  [401] = "A valid authorization token is required",
  [403] = "This API is not granted to the signed-in user",
}

local function claims_of(token)
  if type(token) ~= "string" then
    return nil
  end
  local body = token:match("^[%w_-]+%.([%w_-]+)%.[%w_-]+$")
  if not body or #body % 4 == 1 then
    return nil
  end
  body = body:gsub("%-", "+"):gsub("_", "/")
  body = body .. string.rep("=", (4 - #body % 4) % 4)
  local json = ngx.decode_base64(body)
  local claims = json and cjson.decode(json)
  if type(claims) ~= "table" then
    return nil
  end
  return claims
end

local function status_of(token)
  local claims = claims_of(token)
  if not claims then
    return 401
  end
  if type(claims.role) == "string" and OPEN_ROLES[claims.role] then
    return nil
  end
  if claims.session_id == nil then
    return nil -- signed by Carbon's server, not issued by GoTrue
  end
  if type(claims.authz_api) == "table" then
    for _, resource in ipairs(claims.authz_api) do
      if resource == REQUIRED then
        return nil
      end
    end
  end
  return 403
end

-- Each value of a header or query argument, in order; repeated names give a
-- table, and a bare query flag (`?apikey`) gives true, which is refused.
local function add(found, value, bearer)
  if type(value) == "table" then
    for _, item in ipairs(value) do
      add(found, item, bearer)
    end
  elseif value ~= nil then
    if bearer then
      value = type(value) == "string" and value:match("^[Bb][Ee][Aa][Rr][Ee][Rr] (%S+)$") or false
    end
    found[#found + 1] = value
  end
end

local function credentials()
  local found = {}
  local headers = ngx.req.get_headers(0)
  for _, name in ipairs(HEADERS) do
    add(found, headers[name], name == "authorization")
  end
  add(found, ngx.req.get_uri_args(0).apikey, false)
  return found
end

return function()
  for _, token in ipairs(credentials()) do
    local status = status_of(token)
    if status then
      return kong.response.exit(status, { message = MESSAGES[status] }, { ["Cache-Control"] = "no-store" })
    end
  end
end
