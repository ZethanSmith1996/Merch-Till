export const ROLE_MASTER_ADMIN = "master-admin";
export const ROLE_ADMIN = "admin";
export const ROLE_STAFF = "staff";
export const ROLE_TRAINING = "training";


export function getCurrentUserRole() {
    return sessionStorage.getItem("merchTillRole") || "";
}


export function isMasterAdmin() {
    return getCurrentUserRole() === ROLE_MASTER_ADMIN;
}


export function isAdmin() {
    return getCurrentUserRole() === ROLE_ADMIN;
}


export function isStaff() {
    return getCurrentUserRole() === ROLE_STAFF;
}


export function isTrainingUser() {
    return getCurrentUserRole() === ROLE_TRAINING;
}


export function canManageSessions() {
    const role = getCurrentUserRole();

    return (
        role === ROLE_MASTER_ADMIN ||
        role === ROLE_ADMIN
    );
}


export function canManageProducts() {
    return canManageSessions();
}


export function canViewReports() {
    return canManageSessions();
}


export function canManageUsers() {
    return isMasterAdmin();
}


export function canAccessScreen(screenId) {
    switch (screenId) {
        case "till-section":
            return true;

        case "products-section":
            return canManageProducts();

        case "reports-section":
            return canViewReports();

        case "users-section":
            return canManageUsers();

        default:
            return false;
    }
}