// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { carbon, respond } from "@carbon/api/carbon.server";
import { error } from "@carbon/auth";
import { requirePermissions } from "@carbon/auth/auth.server";
import { flash } from "@carbon/auth/session.server";
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
import {
  EmployeeTypeForm,
  employeeTypePermissionsValidator,
  employeeTypeValidator,
  getModules,
  insertEmployeeType,
  upsertEmployeeTypePermissions
} from "~/modules/users";
import { makeEmptyPermissionsFromModules } from "~/modules/users/users.server";
||||||| 85d9006e1
import { validationError, validator } from "@carbon/form";
import type {
  ActionFunctionArgs,
  ClientActionFunctionArgs,
  LoaderFunctionArgs
} from "react-router";
import { data, redirect, useLoaderData } from "react-router";
import type { CompanyPermission } from "~/modules/users";
import {
  EmployeeTypeForm,
  employeeTypePermissionsValidator,
  employeeTypeValidator,
  getModules,
  insertEmployeeType,
  upsertEmployeeTypePermissions
} from "~/modules/users";
import { makeEmptyPermissionsFromModules } from "~/modules/users/users.server";
=======
import { makeEmptyPermissionsFromModules } from "@carbon/ee/permissions.server";
import { requireFeature } from "@carbon/ee/plan.server";
import { validator } from "@carbon/form";
import { redirect } from "@carbon/utils";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { EmployeeTypeForm } from "~/modules/users/ui";
import { employeeTypeValidator } from "~/modules/users/users.models";
import { getModules } from "~/modules/users/users.service";
>>>>>>> 2beccc9789c598823f9d9584cdeecce9c7ffac75
import { path } from "~/utils/path";

export async function loader({ request }: LoaderFunctionArgs) {
  const { client, companyId } = await requirePermissions(request, {
    create: "users"
  });

  await requireFeature({
    request,
    client,
    companyId,
    redirectTo: path.to.employeeAccounts,
    feature: "PERMISSIONS"
  });

  const modules = await getModules(client);
  if (modules.error || modules.data === null) {
    throw redirect(
      path.to.employeeTypes,
      await flash(request, error(modules.error, "Failed to get modules"))
    );
  }

  return {
    permissions: makeEmptyPermissionsFromModules(modules.data),
    authz: await getAuthzManagement()
  };
}

<<<<<<< HEAD
export async function action({ request }: ActionFunctionArgs) {
  assertIsPost(request);
  const { client, companyId } = await requirePermissions(request, {
    create: "users"
  });
  await refuseWhileAuthzManaged(request, path.to.employeeTypes);

  const validation = await validator(employeeTypeValidator).validate(
    await request.formData()
  );

  if (validation.error) {
    return validationError(validation.error);
  }

  const { name, data: permissionData } = validation.data;

  const permissions = JSON.parse(permissionData) as {
    name: string;
    permission: CompanyPermission;
  }[];
  const jsonValidation =
    employeeTypePermissionsValidator.safeParse(permissions);
  if (jsonValidation.success === false) {
    return data(
      {},
      await flash(
        request,
        error(jsonValidation.error, "Failed to parse permissions")
      )
    );
  }

  const createEmployeeType = await insertEmployeeType(client, {
||||||| 85d9006e1
export async function action({ request }: ActionFunctionArgs) {
  assertIsPost(request);
  const { client, companyId } = await requirePermissions(request, {
    create: "users"
  });

  const validation = await validator(employeeTypeValidator).validate(
    await request.formData()
  );

  if (validation.error) {
    return validationError(validation.error);
  }

  const { name, data: permissionData } = validation.data;

  const permissions = JSON.parse(permissionData) as {
    name: string;
    permission: CompanyPermission;
  }[];
  const jsonValidation =
    employeeTypePermissionsValidator.safeParse(permissions);
  if (jsonValidation.success === false) {
    return data(
      {},
      await flash(
        request,
        error(jsonValidation.error, "Failed to parse permissions")
      )
    );
  }

  const createEmployeeType = await insertEmployeeType(client, {
=======
export async function action(args: ActionFunctionArgs) {
  const input = await validator(employeeTypeValidator).request(args);
  if ("invalid" in input) return input.invalid;
  const { name, data: permissions } = input.data;
  const api = await carbon(args.request);
  const result = await api.users.createEmployeeType({
>>>>>>> 2beccc9789c598823f9d9584cdeecce9c7ffac75
    name,
    permissions: JSON.parse(permissions)
  });
  return respond(args.request, result).redirect(path.to.employeeTypes, {
    message: "Employee type created",
    onError: path.to.newEmployeeType
  });
}

export default function NewEmployeeTypesRoute() {
  const { permissions, authz } = useLoaderData<typeof loader>();
  if (authz.managed) {
    return <AuthzManagedPermissions accessUrl={authz.accessUrl} />;
  }

  const initialValues = {
    name: "",
    data: "",
    permissions
  };

  return <EmployeeTypeForm initialValues={initialValues} />;
}
