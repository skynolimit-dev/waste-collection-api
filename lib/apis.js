const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());

const bins = require('./bins');


function serve() {

    // Healthcheck endpoint
    app.get('/api/v1/healthcheck', (req, res) => {
        try {
            const cache = bins.getCache();
            const cacheSize = Object.keys(cache).length;
            if (cacheSize > 0)
                res.json({ status: 'ok', cacheSize: cacheSize });
            else
                res.json({ status: 'error', message: 'No cache data found' });
        } catch (error) {
            res.json({ status: 'error', message: error });
        }
    });

    // API endpoint to get the bin details for a given bin ID
    app.get('/api/v1/bin/:id', async (req, res) => {
        const id = req.params.id;
        const binDetails = await bins.getBinDetails(id);
        res.json(binDetails);
    });

    // API endpoint to return details on the next collections for a given bin ID
    app.get('/api/v1/bin/:id/next_collections', async (req, res) => {
        const id = req.params.id;
        res.json(await bins.getNextCollections(id));
    });

    // API endpoint to return an array of bin categories that are due for collection tomorrow
    app.get('/api/v1/bin/:id/bins_for_tomorrow', async (req, res) => {
        const id = req.params.id;
        const binsForTomorrow = await bins.getBinsForTomorrow(id);
        res.json(binsForTomorrow);
    });

    // API endpoint to return test data for the above endpoint
    app.get('/api/v1/bin/:id/bins_for_tomorrow_test', async (req, res) => {
        res.json([
            "Food Waste",
            "Mixed Recycling (Cans, Plastics & Glass)",
            "Paper & Cardboard",
            "Non-Recyclable Refuse",
            "Bulky Waste",
            "Batteries, small electrical items and textiles"
        ]);
    });

    // API endpoint to get the cache contents
    app.get('/api/v1/cache', async (req, res) => {
        res.json(bins.getCache());
    });


    // Debug - API endpoint to render a URL using Puppeteer
    // The URL should be specified as a "url" query parameter
    app.get('/api/v1/debug/render', async (req, res) => {
        const url = req.query.url;
        if (!url) {
            return res.send('please provide url');
        }
        try {
            const browser = await puppeteer.launch(
                {
                    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
                    args: [
                        // Required for Docker version of Puppeteer
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        // This will write shared memory files into /tmp instead of /dev/shm,
                        // because Docker’s default for /dev/shm is 64MB
                        '--disable-dev-shm-usage'
                    ],
                });

            const page = await browser.newPage();
            await page.goto(url, { waitUntil: 'networkidle0' });
            await page.waitForFunction(
                'document.querySelector("body").innerText.includes("Your collections")'
            );
            const pageContent = await page.content();
            await browser.close();

            res.send(pageContent);
        } catch (err) {
            console.log(`Error while fetching ${url} `, err);
            res.send(`Error fetching ${url}`);
        }
    });

    // Start the server
    const PORT = process.env.PORT || 3004;
    app.listen(PORT, () => {
        console.log(`Listening on port ${PORT}`);
    });

}

module.exports = {
    serve
}