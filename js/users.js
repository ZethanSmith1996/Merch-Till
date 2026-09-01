import { dom } from "./dom.js";
import { state } from "./state.js";
import {
    addUserToDatabase,
    deleteUserFromDatabase,
    loadUsersFromDatabase,
    saveUserToDatabase
} from "./database.js";
import { canManageUsers } from "./permissions.js";
import { escapeHTML } from "./utils.js";
import { getValidCloudAccessToken } from "./auth.js";
import { supabaseConfig } from "./config.js";

const roleLabels = {
    "master-admin": "Master Admin",
    admin: "Admin",
    staff: "Staff",
    training: "Training"
};

function requireMasterAdmin() {
    if (canManageUsers()) {
        return true;
    }

    window.alert("Only the Master Admin can manage users.");
    return false;
}

function currentUsername() {
    return sessionStorage.getItem("merchTillUsername") || "";
}

function getNextLocalIdFallback() {
    if (state.users.length === 0) return 1;
    return Math.max(...state.users.map(function (user) { return user.id || 0; })) + 1;
}


function setCloudUserTestStatus(message, isError = false) {
    if (!dom.cloudUserTestStatus) return;

    dom.cloudUserTestStatus.hidden = false;
    dom.cloudUserTestStatus.textContent = message;
    dom.cloudUserTestStatus.style.color = isError ? "#991b1b" : "#1f2937";
    dom.cloudUserTestStatus.style.background = isError ? "#fee2e2" : "#eef2ff";
    dom.cloudUserTestStatus.style.border = isError ? "1px solid #fecaca" : "1px solid #c7d2fe";
    dom.cloudUserTestStatus.style.padding = "12px 14px";
    dom.cloudUserTestStatus.style.borderRadius = "10px";
}

async function testCloudUserManagement() {
    if (!requireMasterAdmin()) return;

    if (!navigator.onLine) {
        setCloudUserTestStatus(
            "This test needs an internet connection because it calls the Supabase Edge Function.",
            true
        );
        return;
    }

    const confirmed = window.confirm(
        "This test will create one temporary Staff account in Supabase Auth and public.profiles.\n\n" +
        "Nothing else in the Till will be changed. Continue?"
    );

    if (!confirmed) return;

    const button = dom.testCloudUserManagementButton;
    const originalText = button?.textContent || "Test Cloud User Management";

    try {
        if (button) {
            button.disabled = true;
            button.textContent = "Testing…";
        }

        setCloudUserTestStatus("Checking the current Master cloud session…");

        const accessToken = await getValidCloudAccessToken();

        if (!accessToken) {
            throw new Error(
                "No valid Master Supabase session is available. Log out, log back in as master while online, then try again."
            );
        }

        const uniqueSuffix = Date.now().toString().slice(-10);
        const username = `cloudtest${uniqueSuffix}`;
        const email = `${username}@example.com`;

        setCloudUserTestStatus("Calling the secure manage-users Edge Function…");

        const response = await fetch(
            `${supabaseConfig.url}/functions/v1/manage-users`,
            {
                method: "POST",
                headers: {
                    "apikey": supabaseConfig.publishableKey,
                    "Authorization": `Bearer ${accessToken}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    action: "create-user",
                    username,
                    email,
                    password: `TempTest${uniqueSuffix}!`,
                    role: "staff"
                })
            }
        );

        let result = null;
        try {
            result = await response.json();
        } catch (error) {
            result = null;
        }

        if (!response.ok || !result?.success) {
            const details = result?.details ? ` (${result.details})` : "";
            throw new Error(
                `${result?.error || `Edge Function returned HTTP ${response.status}`}${details}`
            );
        }

        setCloudUserTestStatus(
            `SUCCESS — secure Master authorisation worked. Supabase created temporary user "${result.user.username}" (${result.user.email}) with role "${result.user.role}". Check Authentication → Users and public.profiles to confirm both records exist.`
        );
    } catch (error) {
        console.error("Cloud user management test failed:", error);
        setCloudUserTestStatus(
            `TEST FAILED — ${error instanceof Error ? error.message : "Unknown error."}`,
            true
        );
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = originalText;
        }
    }
}

export function renderUsersTable() {
    if (!dom.usersTableBody || !dom.noUsersMessage) return;

    dom.usersTableBody.innerHTML = "";
    dom.noUsersMessage.hidden = state.users.length > 0;

    state.users.forEach(function (user) {
        const row = document.createElement("tr");
        const statusText = user.active ? "Active" : "Disabled";
        const protectedText = user.protected ? " · Protected" : "";

        row.innerHTML = `
            <td><strong>${escapeHTML(user.username)}</strong></td>
            <td>${roleLabels[user.role] || escapeHTML(user.role)}</td>
            <td>${statusText}${protectedText}</td>
            <td>
                <div class="product-actions">
                    <button type="button" class="edit-user-button">Edit</button>
                    <button type="button" class="delete-user-button">Delete</button>
                </div>
            </td>
        `;

        const editButton = row.querySelector(".edit-user-button");
        const deleteButton = row.querySelector(".delete-user-button");

        editButton.addEventListener("click", function () {
            openEditUserModal(user.id);
        });

        deleteButton.disabled = Boolean(user.protected) || user.username === currentUsername();
        deleteButton.addEventListener("click", function () {
            deleteUser(user.id);
        });

        dom.usersTableBody.appendChild(row);
    });
}

function openAddUserModal() {
    if (!requireMasterAdmin()) return;

    dom.userForm.reset();
    dom.editingUserIdInput.value = "";
    dom.userModalTitle.textContent = "Add User";
    dom.userPasswordInput.required = true;
    dom.userPasswordHelp.textContent = "A password is required for a new user.";
    dom.userActiveInput.checked = true;
    dom.userFormError.textContent = "";
    dom.userModal.hidden = false;
    dom.userUsernameInput.focus();
}

function openEditUserModal(userId) {
    if (!requireMasterAdmin()) return;

    const user = state.users.find(function (item) {
        return item.id === userId;
    });

    if (!user) return;

    dom.editingUserIdInput.value = String(user.id);
    dom.userUsernameInput.value = user.username;
    dom.userPasswordInput.value = "";
    dom.userPasswordInput.required = false;
    dom.userPasswordHelp.textContent = "Leave blank to keep the current password.";
    dom.userRoleInput.value = user.role;
    dom.userActiveInput.checked = Boolean(user.active);
    dom.userModalTitle.textContent = "Edit User";
    dom.userFormError.textContent = "";

    if (user.protected) {
        dom.userRoleInput.value = "master-admin";
        dom.userRoleInput.disabled = true;
        dom.userActiveInput.disabled = true;
        dom.userUsernameInput.disabled = true;
    } else {
        dom.userRoleInput.disabled = false;
        dom.userActiveInput.disabled = false;
        dom.userUsernameInput.disabled = false;
    }

    dom.userModal.hidden = false;
    dom.userPasswordInput.focus();
}

function closeUserModal() {
    dom.userModal.hidden = true;
    dom.userForm.reset();
    dom.editingUserIdInput.value = "";
    dom.userFormError.textContent = "";
    dom.userRoleInput.disabled = false;
    dom.userActiveInput.disabled = false;
    dom.userUsernameInput.disabled = false;
}

async function saveUser(event) {
    event.preventDefault();
    if (!requireMasterAdmin()) return;

    const editingId = Number(dom.editingUserIdInput.value);
    const username = dom.userUsernameInput.value.trim();
    const password = dom.userPasswordInput.value;
    const role = dom.userRoleInput.value;
    const active = dom.userActiveInput.checked;

    if (!username) {
        dom.userFormError.textContent = "Please enter a username.";
        return;
    }

    if (!editingId && !password) {
        dom.userFormError.textContent = "Please enter a password.";
        return;
    }

    const duplicate = state.users.find(function (user) {
        return (
            user.username.toLowerCase() === username.toLowerCase() &&
            user.id !== editingId
        );
    });

    if (duplicate) {
        dom.userFormError.textContent = "That username is already in use.";
        return;
    }

    try {
        if (editingId) {
            const user = state.users.find(function (item) {
                return item.id === editingId;
            });

            if (!user) {
                dom.userFormError.textContent = "The user could not be found.";
                return;
            }

            const updatedUser = {
                ...user,
                username: user.protected ? user.username : username,
                role: user.protected ? user.role : role,
                active: user.protected ? true : active
            };

            if (password) {
                updatedUser.password = password;
            }

            await saveUserToDatabase(updatedUser);
        } else {
            await addUserToDatabase({
                username,
                password,
                role,
                active,
                protected: false,
                localIdFallback: getNextLocalIdFallback()
            });
        }

        await loadUsersFromDatabase();
        closeUserModal();
        renderUsersTable();

    } catch (error) {
        console.error("User could not be saved:", error);
        dom.userFormError.textContent = "The user could not be saved.";
    }
}

async function deleteUser(userId) {
    if (!requireMasterAdmin()) return;

    const user = state.users.find(function (item) {
        return item.id === userId;
    });

    if (!user || user.protected || user.username === currentUsername()) {
        window.alert("This user cannot be deleted.");
        return;
    }

    const confirmed = window.confirm(
        `Delete \"${user.username}\"?\n\nThis cannot be undone.`
    );

    if (!confirmed) return;

    try {
        await deleteUserFromDatabase(user.id);
        await loadUsersFromDatabase();
        renderUsersTable();
    } catch (error) {
        console.error("User could not be deleted:", error);
        window.alert("The user could not be deleted.");
    }
}

export function initialiseUserManagement() {
    if (!dom.addUserButton) return;

    dom.addUserButton.addEventListener("click", openAddUserModal);

    if (dom.testCloudUserManagementButton) {
        dom.testCloudUserManagementButton.addEventListener(
            "click",
            testCloudUserManagement
        );
    }
    dom.closeUserModalButton.addEventListener("click", closeUserModal);
    dom.cancelUserButton.addEventListener("click", closeUserModal);
    dom.userForm.addEventListener("submit", saveUser);

    dom.userModal.addEventListener("click", function (event) {
        if (event.target === dom.userModal) {
            closeUserModal();
        }
    });

    document.addEventListener("keydown", function (event) {
        if (event.key === "Escape" && !dom.userModal.hidden) {
            closeUserModal();
        }
    });
}
