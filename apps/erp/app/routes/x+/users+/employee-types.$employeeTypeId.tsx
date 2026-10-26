// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { carbon, respond } from "@carbon/api/carbon.server";
import { notFound } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
<<<<<<< HEAD
import { flash } from "@carbon/auth/session.server";
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
||||||| 85d9006e1
import { flash } from "@carbon/auth/session.server";
import { validationError, validator } from "@carbon/form";
import type {
  ActionFunctionArgs,
  ClientActionFunctionArgs,
  LoaderFunctionArgs
} from "react-router";
import { data, redirect, useLoaderData } from "react-router";
=======
import { makeCompanyPermissionsFromEmployeeType } from "@carbon/ee/permissions.server";
import { requireFeature } from "@carbon/ee/plan.server";
import { validator } from "@carbon/form";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { EmployeeTypeForm } from "~/modules/users/ui";
import { employeeTypeValidator } from "~/modules/users/users.models";
>>>>>>> 2beccc9789c598823f9d9584cdeecce9c7ffac75
import {
  getEmployeeType,
  getPermissionsByEmployeeType
} from "~/modules/users/users.service";
import { path } from "~/utils/path";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { client, companyId } = await requirePermissions(request, {
    view: "users",
    role: "employee"
  });

  await requireFeature({
    request,
    client,
    companyId,
    redirectTo: path.to.employeeAccounts,
    feature: "PERMISSIONS"
  });

  const { employeeTypeId } = params;
  if (!employeeTypeId) throw notFound("employeeTypeId not found");

  const [employeeType, employeeTypePermissions] = await Promise.all([
    getEmployeeType(client, employeeTypeId),
    getPermissionsByEmployeeType(client, employeeTypeId)
  ]);

  return {
    employeeType: employeeType?.data,
    employeeTypePermissions: makeCompanyPermissionsFromEmployeeType(
      employeeTypePermissions.data ?? [],
      companyId
    ),
    authz: await getAuthzManagement()
  };
}

<<<<<<< HEAD
export async function action({ request }: ActionFunctionArgs) {
  assertIsPost(request);
  const { client, companyId } = await requirePermissions(request, {
    update: "users"
  });
  await refuseWhileAuthzManaged(request, path.to.employeeTypes);

  const validation = await validator(employeeTypeValidator).validate(
    await request.formData()
  );

  if (validation.error) {
    return validationError(validation.error);
  }

  const { id, name, data: permissionData } = validation.data;
||||||| 85d9006e1
export async function action({ request }: ActionFunctionArgs) {
  assertIsPost(request);
  const { client, companyId } = await requirePermissions(request, {
    update: "users"
  });

  const validation = await validator(employeeTypeValidator).validate(
    await request.formData()
  );

  if (validation.error) {
    return validationError(validation.error);
  }

  const { id, name, data: permissionData } = validation.data;
=======
export async function action(args: ActionFunctionArgs) {
  const input = await validator(employeeTypeValidator).request(args);
  if ("invalid" in input) return input.invalid;
  const { id, name, data: permissions } = input.data;
>>>>>>> 2beccc9789c598823f9d9584cdeecce9c7ffac75
  if (!id) throw notFound("id not found");
  const api = await carbon(args.request);
  const result = await api.users.updateEmployeeType({
    id,
    name,
    permissions: JSON.parse(permissions)
  });
  return respond(args.request, result).redirect(path.to.employeeTypes, {
    message: "Updated employee type",
    onError: path.to.employeeType(id)
  });
}

export default function EditEmployeeTypesRoute() {
  const { employeeType, employeeTypePermissions, authz } =
    useLoaderData<typeof loader>();
  if (authz.managed) {
    return (
      <AuthzManagedPermissions
        title={employeeType?.name ?? ""}
        accessUrl={authz.accessUrl}
        employeeTypePermissions={employeeTypePermissions}
      />
    );
  }

  const initialValues = {
    id: employeeType?.id ?? "",
    name: employeeType?.name ?? "",
    permissions: employeeTypePermissions
  };

  return (
    <EmployeeTypeForm
      key={initialValues.id}
      // @ts-expect-error
      initialValues={initialValues}
    />
  );
}
