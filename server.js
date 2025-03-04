const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const nodemailer = require('nodemailer');

const app = express();
app.use(bodyParser.json());
app.use(cors());

let products = {};  
let clients = [];  
const weightThreshold = 5;  

// Load environment variables
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_EMAIL_PASS = process.env.ADMIN_EMAIL_PASS;

// **[1] SSE - Real-Time Updates**
app.get('/stream-products', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    clients.push(res);
    res.write(`data: ${JSON.stringify(getCurrentProducts())}\n\n`);

    req.on('close', () => {
        clients = clients.filter(client => client !== res);
    });
});

function broadcastUpdate() {
    const data = JSON.stringify(getCurrentProducts());
    clients.forEach(client => client.write(`data: ${data}\n\n`));
}

function getCurrentProducts() {
    return Object.entries(products)
        .filter(([_, product]) => product.weight >= 2 && product.price >= 0)
        .map(([name, details]) => ({ name, ...details }));  
}

// **[2] Add or Update Product**
app.post('/product', (req, res) => {
    const { name, weight, price, freshness } = req.body;
    if (!name || weight === undefined || price === undefined || !freshness) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    if (products[name]) {
        const prevWeight = products[name].weight;
        if (Math.abs(weight - prevWeight) > weightThreshold) {
            products[name] = { weight, price, freshness };
            broadcastUpdate();
            return res.status(200).json({ message: 'Product updated successfully' });
        } else {
            return res.status(200).json({ message: 'No significant change in weight' });
        }
    } else {
        products[name] = { weight, price, freshness };
        broadcastUpdate();
        return res.status(200).json({ message: 'Product added successfully' });
    }
});

// **[3] Get Products**
app.get('/products', (req, res) => {
    res.status(200).json(getCurrentProducts());
});

// **[4] Delete Product**
app.delete('/product/:name', (req, res) => {
    const { name } = req.params;
    if (products[name]) {
        delete products[name];
        broadcastUpdate();
        return res.status(200).json({ message: `Product ${name} deleted successfully.` });
    }
    return res.status(404).json({ error: `Product ${name} not found.` });
});

// **[5] Confirm Payment and Send Email Receipt**
app.post('/confirm-payment', async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ error: 'Email is required for receipt.' });
    }

    try {
        await sendReceipt(email);
        return res.status(200).json({
            message: 'Payment confirmed, receipt sent.',
            redirectUrl: '/payment_success.html'
        });
    } catch (err) {
        console.error("❌ Error sending receipt:", err.message);
        return res.status(500).json({ error: 'Error sending receipt', details: err.message });
    }
});

async function sendReceipt(email) {
    const productsList = getCurrentProducts();
    const totalAmount = productsList.reduce((sum, p) => sum + p.price, 0).toFixed(2);

    let tableContent = productsList.map(p => `
        <tr>
            <td>${p.name}</td>
            <td>${p.weight}g</td>
            <td>₹${p.price.toFixed(2)}</td>
        </tr>
    `).join('');

    const receiptHTML = `
        <h2>Thank you for your purchase!</h2>
        <table border="1" cellpadding="10" cellspacing="0" style="width: 100%; text-align: left;">
            <thead>
                <tr><th>Product</th><th>Weight (g)</th><th>Price (₹)</th></tr>
            </thead>
            <tbody>${tableContent}</tbody>
        </table>
        <h3>Total: ₹${totalAmount}</h3>
    `;

    const transporter = nodemailer.createTransport({
        service: 'Gmail',
        auth: { user: ADMIN_EMAIL, pass: ADMIN_EMAIL_PASS }
    });

    await transporter.sendMail({
        from: ADMIN_EMAIL,
        to: email,
        subject: "Your Autonomous Checkout Receipt",
        html: receiptHTML
    });

    console.log(`📧 Receipt sent to ${email}`);
}

// **[6] Store Customer Feedback**
app.post('/submit-rating', (req, res) => {
    const { rating } = req.body;
    if (!['😞', '😐', '😊'].includes(rating)) {
        return res.status(400).json({ error: 'Invalid rating.' });
    }
    console.log(`Received rating: ${rating}`);
    return res.status(200).json({ message: 'Thank you for your feedback!' });
});

// **Start Server**
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
