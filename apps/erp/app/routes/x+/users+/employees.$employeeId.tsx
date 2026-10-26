// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { carbon, respond } from "@carbon/api/carbon.server";
import { error, notFound } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { getCarbonServiceRole } from "@carbon/auth/client.server";
import { flash } from "@carbon/auth/session.server";
import type { Json } from "@carbon/database";
<<<<<<< HEAD
import { validationError, validator } from "@carbon/form";
import type {
  ActionFunctionArgs,
  ClientActionFunctionArgs,
  LoaderFunctionArgs
} from "react-router";
import { data, redirect, useLoaderData } from "react-router";
import { AuthzManagedPermissions } from "~/modules/saturn";
import {
  getAuthzManagement,
  refuseWhileAuthzManaged
} from "~/modules/saturn/saturn.server";
import type { CompanyPermission } from "~/modules/users";
||||||| 85d9006e1
import { validationError, validator } from "@carbon/form";
import type {
  ActionFunctionArgs,
  ClientActionFunctionArgs,
  LoaderFunctionArgs
} from "react-router";
import { data, redirect, useLoaderData } from "react-router";
import type { CompanyPermission } from "~/modules/users";
=======
>>>>>>> 2beccc9789c598823f9d9584cdeecce9c7ffac75
import {
  makeCompanyPermissionsFromClaims,
  makeCompanyPermissionsFromEmployeeType
} from "@carbon/ee/permissions.server";
import { validator } from "@carbon/form";
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalHeader,
  ModalOverlay,
  ModalTitle,
  useCloseRoute,
  VStack
} from "@carbon/react";
import { redirect } from "@carbon/utils";
import { Trans } from "@lingui/react/macro";
import { LuShield } from "react-icons/lu";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { UpgradeOverlayUpgradeButton } from "~/components/UpgradeOverlay";
import { usePlanGate } from "~/hooks/usePlanGate";
import type { CompanyPermission } from "~/modules/users/types";
import { EmployeePermissionsForm } from "~/modules/users/ui";
import { employeeValidator } from "~/modules/users/users.models";
import {
  getClaims,
  getEmployee,
  getEmployeeTypes,
  getPermissionsByEmployeeType,
  originOf
} from "~/modules/users/users.service";
import { path } from "~/utils/path";

// The per-user permissions editor is a modal over the accounts list; when the
// company isn't entitled we show the upgrade prompt IN that modal (not a
// full-page overlay), so closing it returns to the accounts list — which stays
// fully usable (inviting people is a Community feature).
function PermissionsUpgradeModal() {
  const closeRoute = useCloseRoute();
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) closeRoute();
      }}
    >
      <ModalOverlay />
      <ModalContent>
        <ModalHeader>
          <ModalTitle>
            <Trans>User Permissions</Trans>
          </ModalTitle>
        </ModalHeader>
        <ModalBody>
          <VStack spacing={4} className="items-center text-center py-6">
            <div className="flex items-center justify-center rounded-full bg-muted size-12">
              <LuShield className="size-6 text-muted-foreground" />
            </div>
            <p className="text-sm text-muted-foreground max-w-sm">
              <Trans>
                Grant each user fine-grained, per-module permissions instead of
                giving everyone full access.
              </Trans>
            </p>
            <UpgradeOverlayUpgradeButton />
          </VStack>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { companyId } = await requirePermissions(request, {
    view: "users",
    role: "employee"
  });

  const { employeeId } = params;
  if (!employeeId) throw notFound("employeeId not found");

  const client = getCarbonServiceRole();

  const [rawClaims, employee, employeeTypes] = await Promise.all([
    getClaims(client, employeeId, companyId),
    getEmployee(client, employeeId, companyId),
    getEmployeeTypes(client, companyId)
  ]);

  if (rawClaims.error || employee.error || rawClaims.data === null) {
    redirect(
      path.to.employeeAccounts,
      await flash(
        request,
        error(
          { rawClaims: rawClaims.error, employee: employee.error },
          "Failed to load employee"
        )
      )
    );
  }
  const claims = makeCompanyPermissionsFromClaims(
    rawClaims.data as Json[],
    companyId
  );

  if (claims === null) {
    redirect(
      path.to.employeeAccounts,
      await flash(request, error(null, "Failed to parse claims"))
    );
  }

  const types = employeeTypes.data ?? [];
  const permissionsByType = await Promise.all(
    types.map((t) => getPermissionsByEmployeeType(client, t.id))
  );
  const employeeTypePermissions: Record<
    string,
    Record<string, CompanyPermission>
  > = {};
  types.forEach((t, i) => {
    const result = permissionsByType[i];
    const raw = makeCompanyPermissionsFromEmployeeType(
      result.data ?? [],
      companyId
    );
    const perms: Record<string, CompanyPermission> = {};
    for (const [mod, entry] of Object.entries(raw)) {
      perms[mod.toLowerCase()] = entry.permission;
    }
    employeeTypePermissions[t.id] = perms;
  });

  return {
    permissions: claims?.permissions,
    employee: employee.data,
    employeeTypes: types,
    employeeTypePermissions,
    authz: await getAuthzManagement()
  };
}

<<<<<<< HEAD
export async function action({ request }: ActionFunctionArgs) {
  assertIsPost(request);
  const { client, companyId, userId } = await requirePermissions(request, {
    update: "users"
  });
  await refuseWhileAuthzManaged(request, path.to.employeeAccounts);

  const validation = await validator(employeeValidator).validate(
    await request.formData()
  );

  if (validation.error) {
    return validationError(validation.error);
  }

  const { id, employeeType, data: permissionData } = validation.data;
  const permissions = JSON.parse(permissionData) as Record<
    string,
    CompanyPermission
  >;

  if (
    !Object.values(permissions).every(
      (permission) => userPermissionsValidator.safeParse(permission).success
    )
  ) {
    return data(
      {},
      await flash(request, error(permissions, "Failed to parse permissions"))
    );
  }

  const ip = request.headers.get("x-forwarded-for") ?? undefined;

  const result = await updateEmployee(client, {
||||||| 85d9006e1
export async function action({ request }: ActionFunctionArgs) {
  assertIsPost(request);
  const { client, companyId, userId } = await requirePermissions(request, {
    update: "users"
  });

  const validation = await validator(employeeValidator).validate(
    await request.formData()
  );

  if (validation.error) {
    return validationError(validation.error);
  }

  const { id, employeeType, data: permissionData } = validation.data;
  const permissions = JSON.parse(permissionData) as Record<
    string,
    CompanyPermission
  >;

  if (
    !Object.values(permissions).every(
      (permission) => userPermissionsValidator.safeParse(permission).success
    )
  ) {
    return data(
      {},
      await flash(request, error(permissions, "Failed to parse permissions"))
    );
  }

  const ip = request.headers.get("x-forwarded-for") ?? undefined;

  const result = await updateEmployee(client, {
=======
export async function action(args: ActionFunctionArgs) {
  const input = await validator(employeeValidator).request(args);
  if ("invalid" in input) return input.invalid;
  const { id, employeeType, data: permissions } = input.data;
  const api = await carbon(args.request);
  const result = await api.users.updateEmployeePermissions({
>>>>>>> 2beccc9789c598823f9d9584cdeecce9c7ffac75
    id,
    employeeType,
    permissions: JSON.parse(permissions),
    ip: originOf(args.request).ip
  });
  return respond(args.request, result).redirect(path.to.employeeAccounts, {
    message: "Permissions updated"
  });
}

export default function UsersEmployeeRoute() {
<<<<<<< HEAD
  const {
    permissions,
    employee,
    employeeTypes,
    employeeTypePermissions,
    authz
  } = useLoaderData<typeof loader>();
  if (authz.managed) {
    return (
      <AuthzManagedPermissions
        title={employee?.name || ""}
        accessUrl={authz.accessUrl}
        companyPermissions={permissions}
      />
    );
||||||| 85d9006e1
  const { permissions, employee, employeeTypes, employeeTypePermissions } =
    useLoaderData<typeof loader>();
=======
  const { permissions, employee, employeeTypes, employeeTypePermissions } =
    useLoaderData<typeof loader>();
  const { isGated } = usePlanGate({ feature: "PERMISSIONS" });

  if (isGated) {
    return <PermissionsUpgradeModal />;
>>>>>>> 2beccc9789c598823f9d9584cdeecce9c7ffac75
  }

  const initialValues = {
    id: employee?.id || "",
    employeeType: employee?.employeeTypeId,
    permissions: permissions || {}
  };

  return (
    <EmployeePermissionsForm
      key={initialValues.id}
      name={employee?.name || ""}
      employeeTypes={employeeTypes}
      employeeTypePermissions={employeeTypePermissions}
      // @ts-expect-error
      initialValues={initialValues}
    />
  );
}
