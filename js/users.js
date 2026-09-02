import { dom } from "./dom.js";
import { canManageUsers } from "./permissions.js";
import { escapeHTML } from "./utils.js";
import { getValidCloudAccessToken } from "./auth.js";

const MANAGE_USERS_URL =
    "https://zdxduhnfjebahfzuqttk.supabase.co/functions/v1/manage-users";

const roleLabels = {
    "master-admin": "Master Admin",
    admin: "Admin",
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

        const role =
            roleLabels[user.role] ||
            escapeHTML(user.role || "");

        const status =
            user.active === true
                ? "Active"
                : "Disabled";

        row.innerHTML = `
            <td>
                <strong>${escapeHTML(user.username || "")}</strong>
            </td>
            <td>${escapeHTML(user.email || "")}</td>
            <td>${role}</td>
            <td>${status}</td>
            <td>
                <span>Cloud managed</span>
            </td>
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

    if (!["staff", "admin"].includes(role)) {
        dom.userFormError.textContent =
            "Choose Staff or Admin.";
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

    window.addEventListener(
        "offline",
        function () {
            if (
                dom.userModal &&
                !dom.userModal.hidden
            ) {
                closeUserModal();
            }

            setUsersStatus(
                "Users unavailable: User management requires an internet connection."
            );
        }
    );
}
