import { currencyFormatter } from "./config.js";
import {
    deleteProductFromDatabase,
    saveProductToDatabase
} from "./database.js";
import { dom } from "./dom.js";
import { state } from "./state.js";
import { announceProductsChanged, escapeHTML } from "./utils.js";

function getNextProductId() {
    if (state.products.length === 0) {
        return 1;
    }

    return Math.max(
        ...state.products.map(function (product) {
            return product.id;
        })
    ) + 1;
}

export function renderProductsTable() {
    dom.productsTableBody.innerHTML = "";

    const hasProducts = state.products.length > 0;
    dom.noProductsMessage.hidden = hasProducts;

    state.products.forEach(function (product) {
        const tableRow = document.createElement("tr");

        const stockClass =
            product.stock <= 0
                ? "stock-value out-of-stock"
                : "stock-value";

        tableRow.innerHTML = `
            <td>
                <span class="product-table-name">
                    ${escapeHTML(product.name)}
                </span>
            </td>
            <td>${currencyFormatter.format(product.price)}</td>
            <td><span class="${stockClass}">${product.stock}</span></td>
            <td>
                <div class="product-actions">
                    <button type="button" class="edit-product-button">Edit</button>
                    <button type="button" class="delete-product-button">Delete</button>
                </div>
            </td>
        `;

        tableRow
            .querySelector(".edit-product-button")
            .addEventListener("click", function () {
                openEditProductModal(product.id);
            });

        tableRow
            .querySelector(".delete-product-button")
            .addEventListener("click", function () {
                deleteProduct(product.id);
            });

        dom.productsTableBody.appendChild(tableRow);
    });
}

function openAddProductModal() {
    dom.productForm.reset();
    dom.editingProductIdInput.value = "";
    dom.productModalTitle.textContent = "Add Product";
    dom.productFormError.textContent = "";
    dom.productModal.hidden = false;
    dom.productNameInput.focus();
}

function openEditProductModal(productId) {
    const product = state.products.find(function (item) {
        return item.id === productId;
    });

    if (!product) {
        return;
    }

    dom.editingProductIdInput.value = String(product.id);
    dom.productNameInput.value = product.name;
    dom.productPriceInput.value = product.price.toFixed(2);
    dom.productStockInput.value = product.stock;
    dom.productModalTitle.textContent = "Edit Product";
    dom.productFormError.textContent = "";
    dom.productModal.hidden = false;
    dom.productNameInput.focus();
}

function closeProductModal() {
    dom.productModal.hidden = true;
    dom.productForm.reset();
    dom.editingProductIdInput.value = "";
    dom.productFormError.textContent = "";
}

function updateCartProduct(product) {
    const cartItem = state.cart.get(product.id);

    if (!cartItem) {
        return;
    }

    cartItem.name = product.name;
    cartItem.price = product.price;

    if (product.stock <= 0) {
        state.cart.delete(product.id);
    } else if (cartItem.quantity > product.stock) {
        cartItem.quantity = product.stock;
    }
}

async function saveProduct(event) {
    event.preventDefault();

    const name = dom.productNameInput.value.trim();
    const price = Number(dom.productPriceInput.value);
    const stock = Number(dom.productStockInput.value);
    const editingProductId = Number(dom.editingProductIdInput.value);

    if (!name) {
        dom.productFormError.textContent = "Please enter a product name.";
        return;
    }

    if (!Number.isFinite(price) || price < 0) {
        dom.productFormError.textContent = "Please enter a valid price.";
        return;
    }

    if (!Number.isInteger(stock) || stock < 0) {
        dom.productFormError.textContent =
            "Stock must be a whole number of zero or more.";
        return;
    }

    const duplicateProduct = state.products.find(function (product) {
        return (
            product.name.toLowerCase() === name.toLowerCase() &&
            product.id !== editingProductId
        );
    });

    if (duplicateProduct) {
        dom.productFormError.textContent =
            "A product with this name already exists.";
        return;
    }

    try {
        if (editingProductId) {
            const product = state.products.find(function (item) {
                return item.id === editingProductId;
            });

            if (!product) {
                dom.productFormError.textContent =
                    "The product could not be found.";
                return;
            }

            product.name = name;
            product.price = price;
            product.stock = stock;

            updateCartProduct(product);
            await saveProductToDatabase(product);
        } else {
            const newProduct = {
                id: getNextProductId(),
                name,
                price,
                stock
            };

            state.products.push(newProduct);
            await saveProductToDatabase(newProduct);
        }

        closeProductModal();
        announceProductsChanged();
    } catch (error) {
        console.error("Product could not be saved:", error);
        dom.productFormError.textContent =
            "The product could not be saved.";
    }
}

async function deleteProduct(productId) {
    const product = state.products.find(function (item) {
        return item.id === productId;
    });

    if (!product) {
        return;
    }

    const shouldDelete = window.confirm(
        `Delete "${product.name}"?\n\nThis cannot be undone.`
    );

    if (!shouldDelete) {
        return;
    }

    try {
        await deleteProductFromDatabase(productId);

        state.products = state.products.filter(function (item) {
            return item.id !== productId;
        });

        state.cart.delete(productId);
        announceProductsChanged();
    } catch (error) {
        console.error("Product could not be deleted:", error);
        window.alert("The product could not be deleted.");
    }
}

export function initialiseProductManagement() {
    dom.addProductButton.addEventListener("click", openAddProductModal);
    dom.closeProductModalButton.addEventListener("click", closeProductModal);
    dom.cancelProductButton.addEventListener("click", closeProductModal);
    dom.productForm.addEventListener("submit", saveProduct);

    dom.productModal.addEventListener("click", function (event) {
        if (event.target === dom.productModal) {
            closeProductModal();
        }
    });

    document.addEventListener("keydown", function (event) {
        if (event.key === "Escape" && !dom.productModal.hidden) {
            closeProductModal();
        }
    });
}
