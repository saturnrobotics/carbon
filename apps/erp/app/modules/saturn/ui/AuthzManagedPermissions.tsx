import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  VStack
} from "@carbon/react";
import { Trans, useLingui } from "@lingui/react/macro";
import { useMemo } from "react";
import { LuShieldCheck } from "react-icons/lu";
import { useNavigate } from "react-router";
import PermissionMatrix from "~/components/PermissionMatrix";
import {
  fromCompanyPermissions,
  fromEmployeeTypePermissions,
  type ModuleDefinition,
  usePermissionMatrix
} from "~/hooks/usePermissionMatrix";
import type { CompanyPermission } from "~/modules/users";

type AuthzManagedPermissionsProps = {
  title?: string;
  accessUrl: string;
  /** A person's permissions (employee screen). */
  companyPermissions?: Record<string, CompanyPermission>;
  /** An employee type's permissions (employee type screens). */
  employeeTypePermissions?: Record<
    string,
    { name: string; permission: CompanyPermission }
  >;
};

/**
 * Replaces a Carbon permission editor while HQ manages permissions: what Carbon
 * currently holds, read-only, and a link to change it in HQ.
 */
const AuthzManagedPermissions = ({
  title,
  accessUrl,
  companyPermissions,
  employeeTypePermissions
}: AuthzManagedPermissionsProps) => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const onClose = () => navigate(-1);

  const matrix = useMemo(() => {
    if (companyPermissions) return fromCompanyPermissions(companyPermissions);
    if (employeeTypePermissions) {
      return fromEmployeeTypePermissions(employeeTypePermissions);
    }
    return null;
  }, [companyPermissions, employeeTypePermissions]);

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <ModalContent size="xlarge">
        <ModalHeader>
          <ModalTitle>{title || t`Permissions`}</ModalTitle>
        </ModalHeader>
        <ModalBody className="max-h-[70dvh] overflow-y-auto">
          <VStack spacing={4}>
            <Alert variant="info">
              <LuShieldCheck />
              <AlertTitle>
                <Trans>Managed in HQ</Trans>
              </AlertTitle>
              <AlertDescription>
                <p>
                  <Trans>
                    Carbon permissions are managed in HQ, so they cannot be
                    changed here.
                  </Trans>
                </p>
                <a className="underline" href={accessUrl}>
                  <Trans>Open HQ access</Trans>
                </a>
              </AlertDescription>
            </Alert>
            {matrix && (
              <ReadOnlyPermissions
                state={matrix.state}
                modules={matrix.modules}
              />
            )}
          </VStack>
        </ModalBody>
        <ModalFooter>
          <Button size="md" variant="solid" onClick={onClose}>
            <Trans>Close</Trans>
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
};

function ReadOnlyPermissions({
  state,
  modules
}: {
  state: Record<string, boolean>;
  modules: ModuleDefinition;
}) {
  const matrix = usePermissionMatrix({ modules, initialState: state });
  const noop = () => undefined;
  return (
    // A disabled fieldset disables every checkbox button inside it.
    <fieldset disabled className="w-full">
      <PermissionMatrix
        matrix={{
          ...matrix,
          toggleCell: noop,
          toggleRow: noop,
          toggleAll: noop
        }}
      />
    </fieldset>
  );
}

export default AuthzManagedPermissions;
