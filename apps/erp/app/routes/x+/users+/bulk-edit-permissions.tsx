// SPDX-License-Identifier: AGPL-3.0-only
// Carbon (github.com/crbnos/carbon). Modified or adapted versions of this file,
// including ports, remain AGPLv3; serving them over a network requires releasing their source.

import { carbon, respond } from "@carbon/api/carbon.server";
import { validator } from "@carbon/form";
import type { ActionFunctionArgs } from "react-router";
<<<<<<< HEAD
import { redirect } from "react-router";
import { refuseWhileAuthzManaged } from "~/modules/saturn/saturn.server";
import {
  bulkPermissionsValidator,
  userPermissionsValidator
} from "~/modules/users";
||||||| 85d9006e1
import { redirect } from "react-router";
import {
  bulkPermissionsValidator,
  userPermissionsValidator
} from "~/modules/users";
=======
import { bulkPermissionsValidator } from "~/modules/users/users.models";
import { originOf } from "~/modules/users/users.service";
>>>>>>> 2beccc9789c598823f9d9584cdeecce9c7ffac75
import { getParams, path } from "~/utils/path";

export async function action(args: ActionFunctionArgs) {
  const input = await validator(bulkPermissionsValidator).request(args);
  if ("invalid" in input) return input.invalid;
  const { editType, userIds, data } = input.data;
  const api = await carbon(args.request);
  const result = await api.users.bulkUpdatePermissions({
    editType,
    userIds,
    permissions: JSON.parse(data),
    ip: originOf(args.request).ip
  });
<<<<<<< HEAD
  await refuseWhileAuthzManaged(request, path.to.employeeAccounts);

  const validation = await validator(bulkPermissionsValidator).validate(
    await request.formData()
  );

  if (validation.error) {
    return validationError(validation.error);
  }

  const { editType, userIds, data } = validation.data;
  const addOnly = editType === "add";
  const permissions: Record<
    string,
    {
      view: boolean;
      create: boolean;
      update: boolean;
      delete: boolean;
    }
  > = JSON.parse(data);

  if (
    !Object.values(permissions).every(
      (permission) => userPermissionsValidator.safeParse(permission).success
    )
  ) {
    throw redirect(
      path.to.employeeAccounts,
      await flash(request, error(permissions, "Failed to parse permissions"))
    );
  }

  const ip = request.headers.get("x-forwarded-for") ?? undefined;

  const batchPayload = userIds.map((id) => ({
    payload: {
      id,
      permissions,
      addOnly,
      companyId,
      actorId: userId,
      ip
    }
  }));

  await batchTrigger("update-permissions", batchPayload);

  throw redirect(
    `${path.to.employeeAccounts}?${getParams(request)}`,
    await flash(request, success("Updating user permissions"))
||||||| 85d9006e1

  const validation = await validator(bulkPermissionsValidator).validate(
    await request.formData()
  );

  if (validation.error) {
    return validationError(validation.error);
  }

  const { editType, userIds, data } = validation.data;
  const addOnly = editType === "add";
  const permissions: Record<
    string,
    {
      view: boolean;
      create: boolean;
      update: boolean;
      delete: boolean;
    }
  > = JSON.parse(data);

  if (
    !Object.values(permissions).every(
      (permission) => userPermissionsValidator.safeParse(permission).success
    )
  ) {
    throw redirect(
      path.to.employeeAccounts,
      await flash(request, error(permissions, "Failed to parse permissions"))
    );
  }

  const ip = request.headers.get("x-forwarded-for") ?? undefined;

  const batchPayload = userIds.map((id) => ({
    payload: {
      id,
      permissions,
      addOnly,
      companyId,
      actorId: userId,
      ip
    }
  }));

  await batchTrigger("update-permissions", batchPayload);

  throw redirect(
    `${path.to.employeeAccounts}?${getParams(request)}`,
    await flash(request, success("Updating user permissions"))
=======
  return respond(args.request, result).redirect(
    `${path.to.employeeAccounts}?${getParams(args.request)}`,
    { message: "Updating user permissions", onError: path.to.employeeAccounts }
>>>>>>> 2beccc9789c598823f9d9584cdeecce9c7ffac75
  );
}
