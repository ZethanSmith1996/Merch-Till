import { currencyFormatter } from "./config.js";
import { dom } from "./dom.js";

import {
    loadProductsFromDatabase,
    saveCompletedSaleTransaction
} from "./database.js";

import { state } from "./state.js";

import {
    announceProductsChanged,
    escapeHTML
} from "./utils.js";

import { createSaleRecord } from "./sales.js";
import { isTrainingUser } from "./permissions.js";


/* ==================================================
   Till product buttons
================================================== */

export function renderTillProducts() {
    dom.productGrid.innerHTML = "";

    const trainingMode = isTrainingUser();

    state.products.forEach(function (product) {
        const productButton =
            document.createElement("button");

        productButton.type = "button";
        productButton.className = "product-button";

        const isSoldOut =
            product.stock <= 0;

        const tradingClosed =
            !state.currentSession &&
            !trainingMode;

        /*
         * Training users can practise even when:
         * - no session is open
         * - a product is sold out
         */
        if (
            (!trainingMode && isSoldOut) ||
            tradingClosed
        ) {
            productButton.disabled = true;

            if (isSoldOut) {
                productButton.classList.add(
                    "sold-out"
                );
            }

            if (tradingClosed) {
                productButton.classList.add(
                    "trading-closed"
                );
            }
        }

        let stockText;

        if (trainingMode) {
            stockText = "Training item";
        } else if (isSoldOut) {
            stockText = "Sold Out";
        } else {
            stockText =
                `${product.stock} in stock`;
        }

        productButton.innerHTML = `
            <span class="product-name">
                ${escapeHTML(product.name)}
            </span>

            <span class="product-price">
                ${currencyFormatter.format(product.price)}
            </span>

            <span class="product-stock">
                ${stockText}
            </span>
        `;

        productButton.addEventListener(
            "click",
            function () {
                addProductToCart(product.id);
            }
        );

        dom.productGrid.appendChild(
            productButton
        );
    });
}


/* ==================================================
   Add product to basket
================================================== */

function addProductToCart(productId) {
    const trainingMode =
        isTrainingUser();

    if (
        !state.currentSession &&
        !trainingMode
    ) {
        window.alert(
            "A trading session is required before you can begin trading."
        );

        return;
    }

    const product =
        state.products.find(function (item) {
            return item.id === productId;
        });

    if (!product) {
        return;
    }

    if (
        !trainingMode &&
        product.stock <= 0
    ) {
        return;
    }

    const currentCartQuantity =
        state.cart.has(productId)
            ? state.cart.get(productId).quantity
            : 0;

    if (
        !trainingMode &&
        currentCartQuantity >= product.stock
    ) {
        window.alert(
            `There are only ${product.stock} ` +
            `${product.name} item(s) available.`
        );

        return;
    }

    if (state.cart.has(productId)) {
        state.cart.get(productId).quantity += 1;
    } else {
        state.cart.set(productId, {
            id: product.id,
            name: product.name,
            price: product.price,
            quantity: 1
        });
    }

    renderCart();
}


/* ==================================================
   Basket quantity controls
================================================== */

function increaseQuantity(productId) {
    const cartItem =
        state.cart.get(productId);

    const product =
        state.products.find(function (item) {
            return item.id === productId;
        });

    if (!cartItem || !product) {
        return;
    }

    if (
        !isTrainingUser() &&
        cartItem.quantity >= product.stock
    ) {
        window.alert(
            `There are only ${product.stock} ` +
            `${product.name} item(s) available.`
        );

        return;
    }

    cartItem.quantity += 1;

    renderCart();
}


function decreaseQuantity(productId) {
    const cartItem =
        state.cart.get(productId);

    if (!cartItem) {
        return;
    }

    if (cartItem.quantity > 1) {
        cartItem.quantity -= 1;
    } else {
        state.cart.delete(productId);
    }

    renderCart();
}


/* ==================================================
   Basket totals
================================================== */

function calculateOrderTotal() {
    let total = 0;

    state.cart.forEach(function (item) {
        total +=
            item.price *
            item.quantity;
    });

    return total;
}


/* ==================================================
   Render current basket
================================================== */

export function renderCart() {
    dom.orderItemsContainer.innerHTML = "";

    const hasItems =
        state.cart.size > 0;

    const trainingMode =
        isTrainingUser();

    dom.emptyOrderMessage.hidden =
        hasItems;

    dom.orderItemsContainer.hidden =
        !hasItems;

    dom.clearOrderButton.disabled =
        !hasItems;

    dom.completeSaleButton.disabled =
        !hasItems ||
        (
            !state.currentSession &&
            !trainingMode
        );

    state.cart.forEach(function (item) {
        const orderItem =
            document.createElement("div");

        orderItem.className =
            "order-item";

        const lineTotal =
            item.price *
            item.quantity;

        orderItem.innerHTML = `
            <div class="order-item-details">

                <div class="order-item-name">
                    ${escapeHTML(item.name)}
                </div>

                <div class="order-item-price">
                    ${currencyFormatter.format(item.price)}
                    each
                </div>

            </div>

            <div class="order-item-controls">

                <button
                    type="button"
                    class="quantity-button decrease-button"
                    aria-label="Decrease ${escapeHTML(item.name)} quantity"
                >
                    −
                </button>

                <span class="item-quantity">
                    ${item.quantity}
                </span>

                <button
                    type="button"
                    class="quantity-button increase-button"
                    aria-label="Increase ${escapeHTML(item.name)} quantity"
                >
                    +
                </button>

                <span class="item-total">
                    ${currencyFormatter.format(lineTotal)}
                </span>

            </div>
        `;

        orderItem
            .querySelector(".decrease-button")
            .addEventListener(
                "click",
                function () {
                    decreaseQuantity(item.id);
                }
            );

        orderItem
            .querySelector(".increase-button")
            .addEventListener(
                "click",
                function () {
                    increaseQuantity(item.id);
                }
            );

        dom.orderItemsContainer.appendChild(
            orderItem
        );
    });

    dom.orderTotal.textContent =
        currencyFormatter.format(
            calculateOrderTotal()
        );
}


/* ==================================================
   Clear basket
================================================== */

export function clearCart() {
    state.cart.clear();
    renderCart();
}


/* ==================================================
   Complete sale
================================================== */

async function completeSale() {
    const trainingMode =
        isTrainingUser();

    if (
        !state.currentSession &&
        !trainingMode
    ) {
        window.alert(
            "A trading session is required before a sale can be completed."
        );

        return;
    }

    if (state.cart.size === 0) {
        return;
    }

    const saleTotal =
        calculateOrderTotal();

    /*
     * Training transactions:
     * - are not saved
     * - do not reduce stock
     * - do not appear in reports
     */
    if (trainingMode) {
        window.alert(
            "Training sale completed.\n\n" +
            `Total: ${currencyFormatter.format(saleTotal)}\n\n` +
            "No stock has been changed.\n" +
            "No transaction has been recorded."
        );

        state.currentOrderNumber += 1;

        dom.orderNumberDisplay.textContent =
            state.currentOrderNumber;

        state.cart.clear();

        renderCart();

        return;
    }

    /*
     * Normal sale behaviour starts here.
     */
    const saleRecord =
        createSaleRecord(saleTotal);

    const updatedProducts =
        state.products.map(function (product) {
            const cartItem =
                state.cart.get(product.id);

            if (!cartItem) {
                return {
                    ...product
                };
            }

            return {
                ...product,
                stock: Math.max(
                    0,
                    product.stock -
                    cartItem.quantity
                )
            };
        });

    dom.completeSaleButton.disabled = true;

    try {
        /*
         * Saves the sale and stock updates
         * together in IndexedDB.
         */
        const savedSaleId =
            await saveCompletedSaleTransaction(
                saleRecord,
                updatedProducts
            );

        state.products =
            updatedProducts;

        state.sales.unshift({
            ...saleRecord,
            id: savedSaleId
        });

        document.dispatchEvent(
            new CustomEvent("sales-changed")
        );

        window.alert(
            "Sale completed successfully.\n\n" +
            `Total: ${currencyFormatter.format(saleTotal)}`
        );

        state.currentOrderNumber += 1;

        dom.orderNumberDisplay.textContent =
            state.currentOrderNumber;

        state.cart.clear();

        announceProductsChanged();

    } catch (error) {
        console.error(
            "The sale could not be saved:",
            error
        );

        window.alert(
            "The sale could not be completed. " +
            "No sale or stock changes have been saved."
        );

        await loadProductsFromDatabase();

        announceProductsChanged();

    } finally {
        renderCart();
    }
}


/* ==================================================
   Initialise Till
================================================== */

export function initialiseTill() {
    dom.clearOrderButton.addEventListener(
        "click",
        function () {
            if (state.cart.size === 0) {
                return;
            }

            const shouldClear =
                window.confirm(
                    "Are you sure you want to clear this order?"
                );

            if (shouldClear) {
                clearCart();
            }
        }
    );

    dom.completeSaleButton.addEventListener(
        "click",
        completeSale
    );

    renderCart();
}


/* ==================================================
   Refresh Till permissions and availability
================================================== */

export function refreshTillAvailability() {
    const trainingMode =
        isTrainingUser();

    if (dom.trainingModeBanner) {
        dom.trainingModeBanner.hidden =
            !trainingMode;
    }

    renderTillProducts();
    renderCart();
}