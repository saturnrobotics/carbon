# OAuth compatibility evaluation

This report is synthetic and disposable. It does not enable native OAuth, Identity Platform, or any production configuration. A native delegation adoption gate fails if any read token reaches a direct write or replay surface.

Adoption gate: **failed**

## Machine-readable matrix

```json
{
  "adoption_gate": "failed",
  "metadata": {
    "compose_project": "carbon-oauth-evaluation-4dffe95d",
    "firebase_live_verification": "untested",
    "gate_failures": [
      "postgrest_rpc_replay",
      "privileged_function_replay",
      "gotrue_user_mutation_replay",
      "wrong_audience",
      "asymmetric_signing"
    ],
    "images": {
      "edge": "supabase/edge-runtime:v1.74.0",
      "gotrue": "supabase/gotrue:v2.189.0",
      "postgrest": "postgrest/postgrest:v13.0.8",
      "realtime": "supabase/realtime:v2.89.0",
      "storage": "supabase/storage-api:v1.58.4"
    },
    "mode": "disposable-synthetic",
    "synthetic_subject": "oauth-evaluation@example.com"
  },
  "results": [
    {
      "evidence": {
        "body": {
          "description": "GoTrue is a user registration and authentication API",
          "name": "GoTrue",
          "version": "v2.189.0"
        },
        "status": 200
      },
      "expected": "200",
      "id": "gotrue_health",
      "observed": "200",
      "status": "pass"
    },
    {
      "evidence": {
        "body": {
          "access_token": "<redacted>",
          "expires_at": 1788832297,
          "expires_in": 3600,
          "refresh_token": "<redacted>",
          "token_type": "bearer",
          "user": {
            "app_metadata": {
              "provider": "email",
              "providers": [
                "email"
              ]
            },
            "aud": "authenticated",
            "confirmed_at": "2026-09-08T00:51:37.366169Z",
            "created_at": "2026-09-08T00:51:37.363716Z",
            "email": "oauth-evaluation@example.com",
            "email_confirmed_at": "2026-09-08T00:51:37.366169Z",
            "id": "db87c044-12a4-42e5-b400-6af285ba7483",
            "identities": [
              {
                "created_at": "2026-09-08T00:51:37.365018Z",
                "email": "oauth-evaluation@example.com",
                "id": "db87c044-12a4-42e5-b400-6af285ba7483",
                "identity_data": {
                  "email": "oauth-evaluation@example.com",
                  "email_verified": false,
                  "phone_verified": false,
                  "sub": "db87c044-12a4-42e5-b400-6af285ba7483"
                },
                "identity_id": "42b6f6e9-41e8-4dc4-9e0c-ac562b7c90d4",
                "last_sign_in_at": "2026-09-08T00:51:37.365001Z",
                "provider": "email",
                "updated_at": "2026-09-08T00:51:37.365018Z",
                "user_id": "db87c044-12a4-42e5-b400-6af285ba7483"
              }
            ],
            "is_anonymous": false,
            "last_sign_in_at": "2026-09-08T00:51:37.431602963Z",
            "phone": "",
            "role": "authenticated",
            "updated_at": "2026-09-08T00:51:37.432959Z",
            "user_metadata": {
              "email_verified": true
            }
          },
          "weak_password": null
        },
        "status": 200
      },
      "expected": "200 with synthetic user token",
      "id": "password_bootstrap",
      "observed": "200",
      "status": "pass"
    },
    {
      "evidence": {
        "client_type": "public",
        "status": 201
      },
      "expected": "201",
      "id": "client_registration",
      "observed": "201",
      "status": "pass"
    },
    {
      "evidence": {
        "authorize": {
          "body": "<a href=\"http://127.0.0.1:18999/oauth/authorizations?authorization_id=vf3n6s26on7liscngymp5pjjerrmojdq\">Found</a>.\n\n",
          "location": "http://127.0.0.1:18999/oauth/authorizations?authorization_id=vf3n6s26on7liscngymp5pjjerrmojdq",
          "status": 302
        },
        "code_issued": true,
        "consent": {
          "body": {
            "redirect_url": "http://127.0.0.1:18994/callback\\1<redacted>&state=synthetic-state"
          },
          "status": 200
        }
      },
      "expected": "authorization code issued",
      "id": "pkce_authorization",
      "observed": "authorize=302 consent=200",
      "status": "pass"
    },
    {
      "evidence": {
        "claims": {
          "aud": "authenticated",
          "client_id": "f1c2f10a-e6a4-4c91-8969-c7b2fdb7aead",
          "role": "authenticated",
          "scope": "email profile",
          "sub": "db87c044-12a4-42e5-b400-6af285ba7483"
        },
        "header_alg": "HS256",
        "response": {
          "body": {
            "access_token": "<redacted>",
            "expires_in": 3600,
            "refresh_token": "<redacted>",
            "token_type": "bearer"
          },
          "status": 200
        }
      },
      "expected": "200 with access and refresh tokens",
      "id": "pkce_token_exchange",
      "observed": "200",
      "status": "pass"
    },
    {
      "evidence": {
        "body": [],
        "status": 200
      },
      "expected": "200",
      "id": "postgrest_read_adapter",
      "observed": "200",
      "status": "pass"
    },
    {
      "evidence": {
        "body": {
          "code": "<redacted>",
          "details": null,
          "hint": null,
          "message": "new row violates row-level security policy for table \"oauth_probe\""
        },
        "status": 403
      },
      "expected": "401/403",
      "id": "postgrest_dml_replay",
      "note": "A successful DML replay fails the native-delegation adoption gate.",
      "observed": "403",
      "status": "pass"
    },
    {
      "evidence": {
        "body": "mutated",
        "status": 200
      },
      "expected": "401/403",
      "id": "postgrest_rpc_replay",
      "note": "The fixture intentionally grants authenticated EXECUTE to expose privileged-RPC replay risk.",
      "observed": "200",
      "status": "fail"
    },
    {
      "evidence": {
        "error": "Remote end closed connection without response",
        "status": null
      },
      "expected": "401/403",
      "id": "storage_write_replay",
      "note": "A closed connection is recorded as untested rather than treated as a denial.",
      "observed": "None",
      "status": "untested"
    },
    {
      "evidence": {
        "error": "Remote end closed connection without response",
        "status": null
      },
      "expected": "deny or explicitly unsupported",
      "id": "realtime_write_replay",
      "note": "REST broadcast is the pinned Realtime write surface; an unavailable endpoint is reported as untested.",
      "observed": "None",
      "status": "untested"
    },
    {
      "evidence": {
        "body": {
          "authorization": "<redacted>",
          "privileged_probe": true
        },
        "status": 200
      },
      "expected": "401/403",
      "id": "privileged_function_replay",
      "note": "The disposable dispatcher is configured without JWT verification to measure the exposed edge boundary.",
      "observed": "200",
      "status": "fail"
    },
    {
      "evidence": {
        "body": {
          "app_metadata": {
            "provider": "email",
            "providers": [
              "email"
            ]
          },
          "aud": "authenticated",
          "confirmed_at": "2026-09-08T00:51:37.366169Z",
          "created_at": "2026-09-08T00:51:37.363716Z",
          "email": "oauth-evaluation@example.com",
          "email_confirmed_at": "2026-09-08T00:51:37.366169Z",
          "id": "db87c044-12a4-42e5-b400-6af285ba7483",
          "identities": [
            {
              "created_at": "2026-09-08T00:51:37.365018Z",
              "email": "oauth-evaluation@example.com",
              "id": "db87c044-12a4-42e5-b400-6af285ba7483",
              "identity_data": {
                "email": "oauth-evaluation@example.com",
                "email_verified": false,
                "phone_verified": false,
                "sub": "db87c044-12a4-42e5-b400-6af285ba7483"
              },
              "identity_id": "42b6f6e9-41e8-4dc4-9e0c-ac562b7c90d4",
              "last_sign_in_at": "2026-09-08T00:51:37.365001Z",
              "provider": "email",
              "updated_at": "2026-09-08T00:51:37.365018Z",
              "user_id": "db87c044-12a4-42e5-b400-6af285ba7483"
            }
          ],
          "is_anonymous": false,
          "last_sign_in_at": "2026-09-08T00:51:37.55886Z",
          "phone": "",
          "role": "authenticated",
          "updated_at": "2026-09-08T00:51:37.654327Z",
          "user_metadata": {
            "email_verified": true,
            "oauth_probe": "write"
          }
        },
        "status": 200
      },
      "expected": "401/403",
      "id": "gotrue_user_mutation_replay",
      "observed": "200",
      "status": "fail"
    },
    {
      "evidence": {
        "body": {
          "error": "invalid_grant",
          "error_description": "Invalid authorization code"
        },
        "status": 400
      },
      "expected": "400/401",
      "id": "authorization_code_replay",
      "observed": "400",
      "status": "pass"
    },
    {
      "evidence": {
        "body": {
          "code": "<redacted>",
          "error_code": "invalid_credentials",
          "msg": "Invalid client credentials"
        },
        "status": 400
      },
      "expected": "400/401",
      "id": "wrong_client_refresh",
      "observed": "400",
      "status": "pass"
    },
    {
      "evidence": {
        "body": "<a href=\"http://127.0.0.1:18994/callback?error=invalid_request&amp;error_description=PKCE+flow+requires+both+code_challenge+and+code_challenge_method&amp;state=missing-pkce\">Found</a>.\n\n",
        "location": "http://127.0.0.1:18994/callback?error=invalid_request&error_description=PKCE+flow+requires+both+code_challenge+and+code_challenge_method&state=missing-pkce",
        "status": 302
      },
      "expected": "reject or redirect with error",
      "id": "missing_pkce",
      "observed": "302",
      "status": "pass"
    },
    {
      "evidence": {
        "body": {
          "code": "<redacted>",
          "error_code": "oauth_client_not_found",
          "msg": "invalid client_id"
        },
        "status": 400
      },
      "expected": "400",
      "id": "unknown_client",
      "observed": "400",
      "status": "pass"
    },
    {
      "evidence": {
        "body": "<a href=\"http://127.0.0.1:18994/callback?error=invalid_request&amp;error_description=unsupported+scope%3A+knowledge%3Aread&amp;state=unsupported\">Found</a>.\n\n",
        "location": "http://127.0.0.1:18994/callback?error=invalid_request&error_description=unsupported+scope%3A+knowledge%3Aread&state=unsupported",
        "status": 302
      },
      "expected": "error response",
      "id": "unsupported_scope",
      "observed": "302",
      "status": "pass"
    },
    {
      "evidence": {
        "body": [],
        "status": 200
      },
      "expected": "401/403",
      "id": "wrong_audience",
      "note": "PostgREST is intentionally run without PGRST_JWT_AUD to reveal whether the audience is enforced.",
      "observed": "200",
      "status": "fail"
    },
    {
      "evidence": {
        "jwks": {
          "body": {
            "keys": []
          },
          "status": 200
        },
        "openid": {
          "body": {
            "authorization_endpoint": "/oauth/authorize",
            "claims_supported": [
              "sub",
              "aud",
              "iss",
              "exp",
              "iat",
              "auth_time",
              "nonce",
              "email",
              "email_verified",
              "phone_number",
              "phone_number_verified",
              "name",
              "picture",
              "preferred_username",
              "updated_at"
            ],
            "code_challenge_methods_supported": [
              "S256",
              "plain"
            ],
            "grant_types_supported": [
              "authorization_code",
              "refresh_token"
            ],
            "id_token_signing_alg_values_supported": [
              "RS256",
              "HS256",
              "ES256"
            ],
            "issuer": "",
            "jwks_uri": "/.well-known/jwks.json",
            "response_modes_supported": [
              "query"
            ],
            "response_types_supported": [
              "code"
            ],
            "scopes_supported": [
              "openid",
              "profile",
              "email",
              "phone"
            ],
            "subject_types_supported": [
              "public"
            ],
            "token_endpoint": "/oauth/token",
            "token_endpoint_auth_methods_supported": [
              "client_secret_basic",
              "client_secret_post",
              "none"
            ],
            "userinfo_endpoint": "/oauth/userinfo"
          },
          "status": 200
        },
        "token_header": {
          "alg": "HS256",
          "typ": "JWT"
        }
      },
      "expected": "asymmetric OIDC signing for ID tokens",
      "id": "asymmetric_signing",
      "note": "HS256 is acceptable for ordinary local Supabase JWTs but does not satisfy asymmetric OIDC ID-token interoperability.",
      "observed": "HS256",
      "status": "fail"
    },
    {
      "evidence": "https://supabase.com/docs/guides/auth/oauth-server/token-security",
      "expected": "OIDC ID token issuance and signature validation",
      "id": "oidc_id_token_flow",
      "observed": "openid scope omitted because no signing key is configured in the disposable stack",
      "status": "untested"
    },
    {
      "evidence": {
        "status": 200
      },
      "expected": "200 for original client",
      "id": "client_bound_refresh",
      "observed": "200",
      "status": "pass"
    },
    {
      "evidence": "https://supabase.com/docs/guides/auth/third-party/firebase-auth",
      "expected": "documentation compatibility",
      "id": "firebase_third_party_supabase",
      "observed": "Supabase documents Firebase JWT verification as a third-party integration",
      "status": "supported"
    },
    {
      "evidence": "https://firebase.google.com/docs/auth/admin/import-users",
      "expected": "preserve application subject IDs",
      "id": "firebase_uuid_preservation",
      "observed": "existing Carbon UUIDs require an import/linking migration and identity mapping",
      "status": "migration-work"
    },
    {
      "evidence": "https://firebase.google.com/docs/auth/web/auth-state-persistence",
      "expected": "documented browser behavior",
      "id": "firebase_origin_session",
      "observed": "web persistence is scoped to an origin",
      "status": "supported"
    },
    {
      "expected": "live issuer/project/role/MFA/linking verification",
      "id": "firebase_live_config",
      "note": "Must be tested in a separately authorized environment.",
      "observed": "no Firebase project, issuer, or credentials supplied",
      "status": "untested"
    }
  ]
}
```
