"""Offline configuration/IAM tests: no cloud requests or static credentials."""
import copy
import subprocess
import unittest
from unittest.mock import MagicMock, call, patch
import invoice_inference as inference


def settings():
    return {"INVOICE_INTAKE_ENABLED": "true", "INVOICE_AI_PROJECT": "example-project",
            "INVOICE_AI_LOCATION": "us", "INVOICE_AI_MODEL": "gemini-3.5-flash",
            "INVOICE_AI_INPUT_PRICE_USD_PER_MILLION": "1.65", "INVOICE_AI_OUTPUT_PRICE_USD_PER_MILLION": "9.90",
            "INVOICE_AI_PRICE_VERIFIED_AT": "2026-09-06"}


class InvoiceInferenceTests(unittest.TestCase):
    def test_absent_configuration_keeps_inference_off(self):
        self.assertEqual(inference.validate({}), {"INVOICE_INTAKE_ENABLED": "false"})
        erp = {"environment": {"EXISTING": "preserved"}}
        inference.configure({}, erp)
        self.assertEqual(erp["environment"], {"EXISTING": "preserved", "INVOICE_INTAKE_ENABLED": "false"})
        cloud = MagicMock(); cloud.c = {"PROJECT_ID": "example-project"}
        inference.provision(cloud)
        cloud.get.assert_not_called(); cloud.call.assert_not_called()

    def test_configuration_rejects_unknown_provider_and_unbounded_costs(self):
        for changes in ({"INVOICE_AI_LOCATION": "global"}, {"INVOICE_AI_MODEL": "https://example.com"},
                        {"INVOICE_AI_PROJECT": "another-project"}, {"INVOICE_AI_MAX_INPUT_TOKENS": "Infinity"},
                        {"INVOICE_AI_MAX_OUTPUT_TOKENS": "999999"}, {"INVOICE_AI_INPUT_PRICE_USD_PER_MILLION": "nan"},
                        {"INVOICE_AI_OUTPUT_PRICE_USD_PER_MILLION": "0"}, {"INVOICE_AI_PRICE_VERIFIED_AT": "2026-02-30"},
                        {"INVOICE_INTAKE_ENABLED": True}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                inference.validate({**settings(), **changes}, project="example-project")
        with self.assertRaises(ValueError):
            inference.configuration({"PROJECT_ID": "example-project"}, {**settings(), "GOOGLE_APPLICATION_CREDENTIALS": "private-key"})
        for key in ("INVOICE_AI_PROJECT", "INVOICE_AI_INPUT_PRICE_USD_PER_MILLION", "INVOICE_AI_OUTPUT_PRICE_USD_PER_MILLION", "INVOICE_AI_PRICE_VERIFIED_AT"):
            value = settings(); value.pop(key)
            with self.assertRaisesRegex(ValueError, key): inference.validate(value)

    def test_only_server_configuration_is_rendered(self):
        erp = {"environment": {}}
        inference.configure({**settings(), "PROJECT_ID": "example-project"}, erp)
        self.assertEqual(erp["environment"]["INVOICE_AI_LOCATION"], "us")
        self.assertNotIn("GOOGLE_APPLICATION_CREDENTIALS", erp["environment"])

    def cloud(self, *, identity=False, unexpected=False):
        cloud = MagicMock()
        cloud.c = {**settings(), "PROJECT_ID": "example-project", "VM_NAME": "example-carbon", "ZONE": "us-east1-b"}
        email = "example-carbon-invoice@example-project.iam.gserviceaccount.com"
        role = "projects/example-project/roles/example_carbon_invoice_inference"
        instance = {"status": "RUNNING", "serviceAccounts": []}
        if identity: instance["serviceAccounts"] = [{"email": email, "scopes": ["https://www.googleapis.com/auth/cloud-platform"]}]
        if unexpected: instance["serviceAccounts"] = [{"email": "other@example-project.iam.gserviceaccount.com"}]
        responses = {("compute", "instances", "describe"): instance,
                     ("iam", "roles", "list"): [{"name": role}] if identity else [],
                     ("iam", "roles", "describe"): {"includedPermissions": ["aiplatform.endpoints.predict"]},
                     ("iam", "service-accounts", "list"): [{"email": email}] if identity else [],
                     ("projects", "get-iam-policy", "example-project"): {"bindings": [{"role": role, "members": ["serviceAccount:" + email]}]} if identity else {"bindings": []}}
        cloud.get.side_effect = lambda *args: copy.deepcopy(responses[args[:3]])
        return cloud

    def test_first_enablement_attaches_only_the_dedicated_inference_identity(self):
        cloud = self.cloud()
        inference.provision(cloud)
        calls = cloud.call.call_args_list
        role_call = next(call.args for call in calls if call.args[:3] == ("iam", "roles", "create"))
        self.assertIn("--permissions=aiplatform.endpoints.predict", role_call)
        self.assertFalse(any("keys" in call.args for call in calls))
        vm_calls = [call.args[2] for call in calls if call.args[:2] == ("compute", "instances")]
        self.assertEqual(vm_calls, ["stop", "set-service-account", "start"])
        self.assertFalse(any("firewall" in str(call.args) for call in calls))

    def test_repeat_deploy_does_not_restart_or_expand_iam(self):
        cloud = self.cloud(identity=True)
        inference.provision(cloud)
        self.assertEqual([call.args[:2] for call in cloud.call.call_args_list], [("services", "enable")])

    def test_new_service_account_binding_retries_only_until_visible(self):
        cloud = self.cloud()
        error = subprocess.CalledProcessError(1, ["gcloud"], stderr=(
            "ERROR: (gcloud.projects.add-iam-policy-binding) INVALID_ARGUMENT: Service account "
            "example-carbon-invoice@example-project.iam.gserviceaccount.com does not exist."))
        bindings = []
        def mutate(*args, **kwargs):
            if args[:2] == ("projects", "add-iam-policy-binding"):
                bindings.append((args, kwargs))
                if len(bindings) < 3: raise error
        cloud.call.side_effect = mutate
        with patch("time.sleep") as sleep:
            inference.provision(cloud)
        self.assertEqual(len(bindings), 3)
        self.assertEqual(sleep.call_args_list, [call(2), call(4)])
        self.assertTrue(all(kwargs == {"capture": True, "capture_error": True} for _, kwargs in bindings))
        self.assertEqual([entry.args[2] for entry in cloud.call.call_args_list if entry.args[:2] == ("compute", "instances")],
                         ["stop", "set-service-account", "start"])

    def test_service_account_propagation_retry_is_bounded_before_vm_stop(self):
        cloud = self.cloud()
        error = subprocess.CalledProcessError(1, ["gcloud"], stderr=(
            "INVALID_ARGUMENT: Service account example-carbon-invoice@example-project.iam.gserviceaccount.com does not exist."))
        def mutate(*args, **kwargs):
            if args[:2] == ("projects", "add-iam-policy-binding"): raise error
        cloud.call.side_effect = mutate
        with patch("time.sleep") as sleep:
            with self.assertRaises(subprocess.CalledProcessError) as failure:
                inference.provision(cloud)
        self.assertIs(failure.exception, error)
        self.assertEqual(sleep.call_args_list, [call(2), call(4), call(8), call(16), call(30)])
        self.assertEqual(sum(entry.args[:2] == ("projects", "add-iam-policy-binding") for entry in cloud.call.call_args_list), 6)
        self.assertFalse(any(entry.args[:2] == ("compute", "instances") for entry in cloud.call.call_args_list))

    def test_binding_does_not_retry_other_errors_or_existing_identity(self):
        for message, existing in [
            ("PERMISSION_DENIED: policy write denied", False),
            ("INVALID_ARGUMENT: role is invalid", False),
            ("INVALID_ARGUMENT: Service account other@example-project.iam.gserviceaccount.com does not exist.", False),
            (None, False),
            ("INVALID_ARGUMENT: Service account example-carbon-invoice@example-project.iam.gserviceaccount.com does not exist.", True),
        ]:
            with self.subTest(message=message, existing=existing):
                cloud = self.cloud()
                if existing:
                    get = cloud.get.side_effect
                    cloud.get.side_effect = lambda *args: ([{"email": "example-carbon-invoice@example-project.iam.gserviceaccount.com"}]
                        if args[:3] == ("iam", "service-accounts", "list") else get(*args))
                error = subprocess.CalledProcessError(1, ["gcloud"], stderr=message)
                def mutate(*args, **kwargs):
                    if args[:2] == ("projects", "add-iam-policy-binding"): raise error
                cloud.call.side_effect = mutate
                with patch("time.sleep") as sleep:
                    with self.assertRaises(subprocess.CalledProcessError) as failure:
                        inference.provision(cloud)
                self.assertIs(failure.exception, error)
                sleep.assert_not_called()
                self.assertEqual(sum(entry.args[:2] == ("projects", "add-iam-policy-binding") for entry in cloud.call.call_args_list), 1)
                self.assertFalse(any(entry.args[:2] == ("compute", "instances") for entry in cloud.call.call_args_list))

    def test_unexpected_existing_identity_fails_before_cloud_mutations(self):
        cloud = self.cloud(unexpected=True)
        with self.assertRaisesRegex(ValueError, "unexpected service account"): inference.provision(cloud)
        cloud.call.assert_not_called()

    def test_restarts_vm_even_if_attachment_fails(self):
        cloud = self.cloud()
        def mutate(*args, **kwargs):
            if args[:3] == ("compute", "instances", "set-service-account"): raise RuntimeError("fixture failure")
        cloud.call.side_effect = mutate
        with self.assertRaises(RuntimeError): inference.provision(cloud)
        self.assertEqual(cloud.call.call_args_list[-1].args[:3], ("compute", "instances", "start"))


if __name__ == "__main__": unittest.main()
