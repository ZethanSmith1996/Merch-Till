import { dom } from "./dom.js";
import { canManageUsers } from "./permissions.js";
import { escapeHTML } from "./utils.js";
import { getValidCloudAccessToken } from "./auth.js";
import { logAuditEvent, auditActorUsername } from "./audit-log.js?v=priority10c";

const MANAGE_USERS_URL =
    "https://zdxduhnfjebahfzuqttk.supabase.co/functions/v1/manage-users";

const roleLabels = {
    "master-admin": "Master Admin",
    admin: "Admin",
    manager: "Manager",
    staff: "Staff",
    training: "Training"
};

let cloudUsers = [];

function setUsersStatus(message) {
    const status = document.getElementById("cloud-users-status");

    if (status) {
        status.textContent = message;
    }
}

function renderCloudUsers() {
    if (!dom.usersTableBody || !dom.noUsersMessage) return;

    dom.usersTableBody.innerHTML = "";
    dom.noUsersMessage.hidden = cloudUsers.length > 0;

    cloudUsers.forEach(function (user) {
        const row = document.createElement("tr");

        const status =
            user.active === true
                ? "Active"
                : "Disabled";

        const isMaster =
            user.role === "master-admin";

        const roleMarkup = isMaster
            ? `<span>${roleLabels["master-admin"]}</span>`
            : `
                <select
                    class="user-role-select"
                    data-user-id="${escapeHTML(user.id || "")}"
                    data-current-role="${escapeHTML(user.role || "")}"
                    aria-label="Role for ${escapeHTML(user.username || "")}"
                >
                    <option value="staff" ${user.role === "staff" ? "selected" : ""}>
                        Staff
                    </option>
                    <option value="admin" ${user.role === "admin" ? "selected" : ""}>
                        Admin
                    </option>
                    <option value="manager" ${user.role === "manager" ? "selected" : ""}>
                        Manager
                    </option>
                </select>
            `;

        const statusActionMarkup = isMaster
            ? `
                <button
                    type="button"
                    class="user-password-button"
                    data-user-id="${escapeHTML(user.id || "")}"
                >
                    Change Password
                </button>
                <span>Protected</span>
            `
            : `
                <button
                    type="button"
                    class="user-password-button"
                    data-user-id="${escapeHTML(user.id || "")}"
                >
                    Change Password
                </button>

                <button
                    type="button"
                    class="user-status-button"
                    data-user-id="${escapeHTML(user.id || "")}"
                    data-user-active="${user.active === true ? "true" : "false"}"
                >
                    ${user.active === true ? "Disable" : "Enable"}
                </button>
            `;

        row.innerHTML = `
            <td>
                <strong>${escapeHTML(user.username || "")}</strong>
            </td>
            <td>${escapeHTML(user.email || "")}</td>
            <td>${roleMarkup}</td>
            <td>${status}</td>
            <td>${statusActionMarkup}</td>
        `;

        dom.usersTableBody.appendChild(row);
    });
}

async function callManageUsers(action, payload = {}) {
    if (!navigator.onLine) {
        throw new Error(
            "User management is unavailable offline. Connect to the internet and try again."
        );
    }

    const accessToken =
        await getValidCloudAccessToken();

    if (!accessToken) {
        throw new Error(
            "No valid cloud session was found. Log out and log back in as Master while online."
        );
    }

    const response = await fetch(
        MANAGE_USERS_URL,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization":
                    `Bearer ${accessToken}`
            },
            body: JSON.stringify({
                action,
                ...payload
            })
        }
    );

    const responseText =
        await response.text();

    let data = null;

    try {
        data = JSON.parse(responseText);
    } catch (error) {
        data = null;
    }

    if (!response.ok) {
        throw new Error(
            data?.details ||
            data?.message ||
            data?.error ||
            responseText ||
            `HTTP ${response.status}`
        );
    }

    return data;
}

async function fetchCloudUsers() {
    if (!canManageUsers()) {
        cloudUsers = [];
        renderCloudUsers();
        return;
    }

    const refreshButton =
        document.getElementById("refresh-cloud-users-button");

    if (refreshButton) {
        refreshButton.disabled = true;
    }

    setUsersStatus("Loading cloud users…");

    try {
        const data =
            await callManageUsers("list-users");

        cloudUsers =
            Array.isArray(data?.users)
                ? data.users
                : [];

        renderCloudUsers();

        setUsersStatus(
            `Cloud users loaded successfully (${cloudUsers.length}).`
        );

    } catch (error) {
        console.error(
            "Cloud users could not be loaded:",
            error
        );

        cloudUsers = [];
        renderCloudUsers();

        const message =
            error instanceof Error
                ? error.message
                : String(error);

        setUsersStatus(
            `Users unavailable: ${message}`
        );

    } finally {
        if (refreshButton) {
            refreshButton.disabled = false;
        }
    }
}

function openAddUserModal() {
    if (!canManageUsers()) return;

    if (!navigator.onLine) {
        setUsersStatus(
            "Users unavailable: User creation requires an internet connection."
        );
        return;
    }

    if (
        !dom.userModal ||
        !dom.userModalTitle ||
        !dom.userForm ||
        !dom.userUsernameInput ||
        !dom.userPasswordInput ||
        !dom.userRoleInput ||
        !dom.userFormError
    ) {
        return;
    }

    const emailInput =
        document.getElementById("user-email");

    if (!emailInput) return;

    dom.userModalTitle.textContent =
        "Add Cloud User";

    dom.userForm.reset();
    dom.userUsernameInput.value = "";
    emailInput.value = "";
    dom.userPasswordInput.value = "";
    dom.userRoleInput.value = "staff";
    dom.userFormError.textContent = "";

    if (dom.userPasswordHelp) {
        dom.userPasswordHelp.textContent =
            "Minimum 8 characters. The password is sent securely to Supabase and is not stored locally.";
    }

    dom.userModal.hidden = false;
    dom.userUsernameInput.focus();
}

function closeUserModal() {
    if (!dom.userModal || !dom.userFormError) return;

    dom.userModal.hidden = true;
    dom.userFormError.textContent = "";
}

async function submitCloudUser(event) {
    event.preventDefault();

    if (!canManageUsers()) return;

    const emailInput =
        document.getElementById("user-email");

    if (
        !emailInput ||
        !dom.userUsernameInput ||
        !dom.userPasswordInput ||
        !dom.userRoleInput ||
        !dom.userFormError
    ) {
        return;
    }

    const username =
        dom.userUsernameInput.value
            .trim()
            .toLowerCase();

    const email =
        emailInput.value
            .trim()
            .toLowerCase();

    const password =
        dom.userPasswordInput.value;

    const role =
        dom.userRoleInput.value;

    dom.userFormError.textContent = "";

    if (!username) {
        dom.userFormError.textContent =
            "Enter a username.";
        return;
    }

    if (!email) {
        dom.userFormError.textContent =
            "Enter an email address.";
        return;
    }

    if (password.length < 8) {
        dom.userFormError.textContent =
            "Password must contain at least 8 characters.";
        return;
    }

    if (!["staff", "admin", "manager"].includes(role)) {
        dom.userFormError.textContent =
            "Choose Staff, Admin or Manager.";
        return;
    }

    const submitButton =
        dom.userForm.querySelector(
            'button[type="submit"]'
        );

    if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent =
            "Creating User…";
    }

    try {
        const data =
            await callManageUsers(
                "create-user",
                {
                    username,
                    email,
                    password,
                    role
                }
            );

        closeUserModal();

        setUsersStatus(
            data?.message ||
            `Cloud user "${username}" created successfully.`
        );

        await logAuditEvent(
            "user_management",
            `${auditActorUsername()} created user "${username}" as ${roleLabels[role] || role}.`,
            {
                target_username:
                    username,
                role
            },
            `user-create:${data?.user?.id || username}:${Date.now()}`
        );

        /*
         * Reload from Supabase immediately so the
         * normal Users table confirms the new account.
         */
        await fetchCloudUsers();

    } catch (error) {
        console.error(
            "Cloud user could not be created:",
            error
        );

        const message =
            error instanceof Error
                ? error.message
                : String(error);

        dom.userFormError.textContent =
            message;

    } finally {
        if (submitButton) {
            submitButton.disabled = false;
            submitButton.textContent =
                "Save User";
        }
    }
}




let passwordChangeTargetUserId = null;

function openPasswordChangeModal(userId) {
    if (!canManageUsers()) return;

    if (!navigator.onLine) {
        setUsersStatus(
            "Users unavailable: Password changes require an internet connection."
        );
        return;
    }

    const targetUser =
        cloudUsers.find(
            (user) => user.id === userId
        );

    if (!targetUser) {
        setUsersStatus(
            "Users unavailable: The selected user could not be found."
        );
        return;
    }

    const modal =
        document.getElementById("password-change-modal");

    const userLabel =
        document.getElementById("password-change-user-label");

    const newPasswordInput =
        document.getElementById("new-cloud-password");

    const confirmPasswordInput =
        document.getElementById("confirm-cloud-password");

    const error =
        document.getElementById("password-change-error");

    if (
        !modal ||
        !userLabel ||
        !newPasswordInput ||
        !confirmPasswordInput ||
        !error
    ) {
        return;
    }

    passwordChangeTargetUserId =
        targetUser.id;

    userLabel.textContent =
        `User: ${targetUser.username}`;

    newPasswordInput.value = "";
    confirmPasswordInput.value = "";
    error.textContent = "";

    modal.hidden = false;
    newPasswordInput.focus();
}

function closePasswordChangeModal() {
    const modal =
        document.getElementById("password-change-modal");

    const error =
        document.getElementById("password-change-error");

    const newPasswordInput =
        document.getElementById("new-cloud-password");

    const confirmPasswordInput =
        document.getElementById("confirm-cloud-password");

    if (modal) {
        modal.hidden = true;
    }

    if (error) {
        error.textContent = "";
    }

    if (newPasswordInput) {
        newPasswordInput.value = "";
    }

    if (confirmPasswordInput) {
        confirmPasswordInput.value = "";
    }

    passwordChangeTargetUserId = null;
}

async function submitCloudPasswordChange(event) {
    event.preventDefault();

    if (!canManageUsers()) return;

    const error =
        document.getElementById("password-change-error");

    const newPasswordInput =
        document.getElementById("new-cloud-password");

    const confirmPasswordInput =
        document.getElementById("confirm-cloud-password");

    if (
        !error ||
        !newPasswordInput ||
        !confirmPasswordInput
    ) {
        return;
    }

    const userId =
        passwordChangeTargetUserId;

    const password =
        newPasswordInput.value;

    const confirmPassword =
        confirmPasswordInput.value;

    error.textContent = "";

    if (!userId) {
        error.textContent =
            "The selected user could not be found.";
        return;
    }

    if (password.length < 8) {
        error.textContent =
            "Password must contain at least 8 characters.";
        return;
    }

    if (password !== confirmPassword) {
        error.textContent =
            "The passwords do not match.";
        return;
    }

    const targetUser =
        cloudUsers.find(
            (user) => user.id === userId
        );

    if (!targetUser) {
        error.textContent =
            "The selected user could not be found.";
        return;
    }

    const confirmed = window.confirm(
        `Change the password for "${targetUser.username}"?`
    );

    if (!confirmed) return;

    const form =
        document.getElementById("password-change-form");

    const submitButton =
        form?.querySelector(
            'button[type="submit"]'
        );

    if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent =
            "Changing Password…";
    }

    try {
        const data =
            await callManageUsers(
                "change-password",
                {
                    userId,
                    password
                }
            );

        closePasswordChangeModal();

        setUsersStatus(
            data?.message ||
            `Password changed successfully for "${targetUser.username}".`
        );

        await logAuditEvent(
            "user_management",
            `${auditActorUsername()} changed the password for "${targetUser.username}".`,
            {
                target_user_id:
                    targetUser.id,
                target_username:
                    targetUser.username,
                action:
                    "password_changed"
            },
            `password-change:${targetUser.id}:${Date.now()}`
        );

    } catch (caughtError) {
        console.error(
            "Cloud password could not be changed:",
            caughtError
        );

        error.textContent =
            caughtError instanceof Error
                ? caughtError.message
                : String(caughtError);

    } finally {
        if (submitButton) {
            submitButton.disabled = false;
            submitButton.textContent =
                "Change Password";
        }
    }
}

async function changeCloudUserRole(userId, newRole, selectElement) {
    if (!canManageUsers()) return;

    const targetUser =
        cloudUsers.find(
            (user) => user.id === userId
        );

    if (!targetUser) {
        setUsersStatus(
            "Users unavailable: The selected user could not be found."
        );
        return;
    }

    if (targetUser.role === "master-admin") {
        setUsersStatus(
            "The Master Admin role is protected and cannot be changed."
        );
        return;
    }

    const oldRole = targetUser.role;

    if (oldRole === newRole) {
        return;
    }

    const oldLabel =
        roleLabels[oldRole] || oldRole;

    const newLabel =
        roleLabels[newRole] || newRole;

    const confirmed = window.confirm(
        `Change "${targetUser.username}" from ${oldLabel} to ${newLabel}?`
    );

    if (!confirmed) {
        if (selectElement) {
            selectElement.value = oldRole;
        }
        return;
    }

    if (selectElement) {
        selectElement.disabled = true;
    }

    setUsersStatus(
        `Changing ${targetUser.username} to ${newLabel}…`
    );

    try {
        const data =
            await callManageUsers(
                "change-role",
                {
                    userId,
                    role: newRole
                }
            );

        setUsersStatus(
            data?.message ||
            `User "${targetUser.username}" changed to ${newLabel}.`
        );

        await logAuditEvent(
            "user_management",
            `${auditActorUsername()} changed "${targetUser.username}" role from ${oldLabel} → ${newLabel}.`,
            {
                target_user_id:
                    targetUser.id,
                target_username:
                    targetUser.username,
                old_role:
                    oldRole,
                new_role:
                    newRole
            },
            `user-role:${targetUser.id}:${Date.now()}`
        );

        await fetchCloudUsers();

    } catch (error) {
        console.error(
            "Cloud user role could not be changed:",
            error
        );

        if (selectElement) {
            selectElement.value = oldRole;
        }

        const message =
            error instanceof Error
                ? error.message
                : String(error);

        setUsersStatus(
            `Role update failed: ${message}`
        );
    } finally {
        if (selectElement) {
            selectElement.disabled = false;
        }
    }
}

async function changeCloudUserStatus(userId, currentlyActive) {
    if (!canManageUsers()) return;

    const targetUser =
        cloudUsers.find(
            (user) => user.id === userId
        );

    if (!targetUser) {
        setUsersStatus(
            "Users unavailable: The selected user could not be found."
        );
        return;
    }

    if (targetUser.role === "master-admin") {
        setUsersStatus(
            "The Master Admin account is protected and cannot be disabled."
        );
        return;
    }

    const action =
        currentlyActive
            ? "disable-user"
            : "enable-user";

    const verb =
        currentlyActive
            ? "disable"
            : "enable";

    const confirmed = window.confirm(
        `Are you sure you want to ${verb} "${targetUser.username}"?`
    );

    if (!confirmed) return;

    setUsersStatus(
        `${currentlyActive ? "Disabling" : "Enabling"} ${targetUser.username}…`
    );

    try {
        const data =
            await callManageUsers(
                action,
                {
                    userId
                }
            );

        setUsersStatus(
            data?.message ||
            `User "${targetUser.username}" updated successfully.`
        );

        await logAuditEvent(
            "user_management",
            `${auditActorUsername()} ${currentlyActive ? "disabled" : "enabled"} user "${targetUser.username}".`,
            {
                target_user_id:
                    targetUser.id,
                target_username:
                    targetUser.username,
                active:
                    !currentlyActive
            },
            `user-status:${targetUser.id}:${currentlyActive ? "disabled" : "enabled"}:${Date.now()}`
        );

        await fetchCloudUsers();

    } catch (error) {
        console.error(
            "Cloud user status could not be changed:",
            error
        );

        const message =
            error instanceof Error
                ? error.message
                : String(error);

        setUsersStatus(
            `User status update failed: ${message}`
        );
    }
}

export function renderUsersTable() {
    return fetchCloudUsers();
}

export function initialiseUserManagement() {
    const refreshButton =
        document.getElementById(
            "refresh-cloud-users-button"
        );

    if (refreshButton) {
        refreshButton.addEventListener(
            "click",
            fetchCloudUsers
        );
    }

    if (dom.usersTableBody) {
        dom.usersTableBody.addEventListener(
            "click",
            function (event) {
                const passwordButton =
                    event.target.closest(
                        ".user-password-button"
                    );

                if (passwordButton) {
                    openPasswordChangeModal(
                        passwordButton.dataset.userId
                    );
                    return;
                }

                const button =
                    event.target.closest(
                        ".user-status-button"
                    );

                if (!button) return;

                const userId =
                    button.dataset.userId;

                const currentlyActive =
                    button.dataset.userActive === "true";

                changeCloudUserStatus(
                    userId,
                    currentlyActive
                );
            }
        );
    }

    if (dom.usersTableBody) {
        dom.usersTableBody.addEventListener(
            "change",
            function (event) {
                const select =
                    event.target.closest(
                        ".user-role-select"
                    );

                if (!select) return;

                changeCloudUserRole(
                    select.dataset.userId,
                    select.value,
                    select
                );
            }
        );
    }

    if (dom.addUserButton) {
        dom.addUserButton.addEventListener(
            "click",
            openAddUserModal
        );
    }

    if (dom.userForm) {
        dom.userForm.addEventListener(
            "submit",
            submitCloudUser
        );
    }

    if (dom.closeUserModalButton) {
        dom.closeUserModalButton.addEventListener(
            "click",
            closeUserModal
        );
    }

    if (dom.cancelUserButton) {
        dom.cancelUserButton.addEventListener(
            "click",
            closeUserModal
        );
    }

    if (dom.userModal) {
        dom.userModal.addEventListener(
            "click",
            function (event) {
                if (event.target === dom.userModal) {
                    closeUserModal();
                }
            }
        );
    }

    const passwordChangeForm =
        document.getElementById("password-change-form");

    const closePasswordChangeButton =
        document.getElementById("close-password-change-modal");

    const cancelPasswordChangeButton =
        document.getElementById("cancel-password-change");

    const passwordChangeModal =
        document.getElementById("password-change-modal");

    if (passwordChangeForm) {
        passwordChangeForm.addEventListener(
            "submit",
            submitCloudPasswordChange
        );
    }

    if (closePasswordChangeButton) {
        closePasswordChangeButton.addEventListener(
            "click",
            closePasswordChangeModal
        );
    }

    if (cancelPasswordChangeButton) {
        cancelPasswordChangeButton.addEventListener(
            "click",
            closePasswordChangeModal
        );
    }

    if (passwordChangeModal) {
        passwordChangeModal.addEventListener(
            "click",
            function (event) {
                if (event.target === passwordChangeModal) {
                    closePasswordChangeModal();
                }
            }
        );
    }

    window.addEventListener(
        "offline",
        function () {
            if (
                dom.userModal &&
                !dom.userModal.hidden
            ) {
                closeUserModal();
            }

            closePasswordChangeModal();

            setUsersStatus(
                "Users unavailable: User management requires an internet connection."
            );
        }
    );
}
