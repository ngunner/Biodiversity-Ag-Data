const { createApp } = Vue

createApp({
    data() {
        return {
            map: null,
            boundary: null,
            isPlaying: false,
            // Simulation parameters
            observationDensity: 1,    // observations per 100km² per month
            detectionRate: 80,        // % chance of detecting pest if present
            startDate: new Date('2024-01-01'),
            endDate: new Date('2024-12-31'),
            currentDate: new Date('2024-01-01'),
            // Simulation state
            observations: [],
            detections: [],
            pestProgress: 0,  // 0 to 1, representing spread from west to east
            accumulatedDetections: new Set(), // Add this to store all successful detections
        }
    },

    mounted() {
        // Initialize map
        this.map = new maplibregl.Map({
            container: 'map',
            style: 'https://demotiles.maplibre.org/style.json',
            center: [-75.6, 42.9],  // NY state center
            zoom: 6
        });

        this.map.on('load', async () => {
            await this.initializeLayers();
            // Load default NY boundary
            try {
                const response = await fetch('./data/ny_state.geojson');
                const geojson = await response.json();
                this.loadBoundaryData(geojson);
            } catch (error) {
                console.error('Error loading default boundary:', error);
            }
        });
    },

    methods: {
        initializeLayers() {
            // Add sources
            this.map.addSource('boundary', {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] }
            });

            this.map.addSource('pest-spread', {
                type: 'geojson',
                data: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [] } }
            });

            this.map.addSource('observations', {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] }
            });

            this.map.addSource('detections', {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] }
            });

            // Add layers
            this.map.addLayer({
                id: 'boundary-layer',
                type: 'line',
                source: 'boundary',
                paint: {
                    'line-color': '#000',
                    'line-width': 2
                }
            });

            this.map.addLayer({
                id: 'pest-spread',
                type: 'fill',
                source: 'pest-spread',
                paint: {
                    'fill-color': '#ff0000',
                    'fill-opacity': 0.2
                }
            });

            this.map.addLayer({
                id: 'observations',
                type: 'circle',
                source: 'observations',
                paint: {
                    'circle-radius': 4,
                    'circle-color': '#666'
                }
            });

            this.map.addLayer({
                id: 'detections',
                type: 'circle',
                source: 'detections',
                paint: {
                    'circle-radius': 6,
                    'circle-color': '#ff0000',
                    'circle-stroke-width': 2,
                    'circle-stroke-color': '#fff'
                }
            });
        },

        async loadBoundary(file) {
            const text = await file.text();
            const geojson = JSON.parse(text);
            this.loadBoundaryData(geojson);
        },

        loadBoundaryData(geojson) {
            try {
                // Convert single Feature to FeatureCollection if necessary
                if (geojson.type === 'Feature') {
                    geojson = {
                        type: 'FeatureCollection',
                        features: [geojson]
                    };
                }

                // Get the first feature and simplify it
                let feature = geojson.features[0];
                
                // First try a convex hull if the geometry is very complex
                const points = turf.explode(feature);
                const hull = turf.convex(points);
                
                // Or use simplification with tolerance
                // const simplified = turf.simplify(feature, {
                //     tolerance: 0.01,
                //     highQuality: true
                // });

                // Create new FeatureCollection with simplified geometry
                this.boundary = {
                    type: 'FeatureCollection',
                    features: [hull] // or [simplified] if using simplification
                };

                // Update map
                this.map.getSource('boundary').setData(this.boundary);
                
                // Fit map to boundary
                const bbox = turf.bbox(this.boundary);
                this.map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 50 });

                console.log('Original vertices:', turf.explode(feature).features.length);
                console.log('Simplified vertices:', turf.explode(hull).features.length);
            } catch (error) {
                console.error('Error simplifying boundary:', error);
                alert('Error processing boundary file. Please try a simpler geometry.');
            }
        },

        startSimulation() {
            if (!this.boundary) {
                alert('Please load a boundary file first');
                return;
            }

            this.isPlaying = true;
            this.currentDate = new Date(this.startDate);
            this.pestProgress = 0;
            this.accumulatedDetections.clear(); // Clear accumulated detections when starting new simulation
            this.generateObservations();
            this.animate();
        },

        generateObservations() {
            const feature = this.boundary.features[0];
            const bbox = turf.bbox(feature);
            const bboxPolygon = turf.bboxPolygon(bbox);
            const bboxArea = turf.area(bboxPolygon) / 1000000; // km²
            
            // Generate extra points to account for those that will be filtered out
            const monthsInSimulation = (this.endDate - this.startDate) / (1000 * 60 * 60 * 24 * 30);
            const areaRatio = bboxArea / (turf.area(feature) / 1000000);
            const totalObservations = Math.ceil((bboxArea / 100) * this.observationDensity * monthsInSimulation);

            // Generate points in bounding box (much faster)
            const points = [];
            for (let i = 0; i < totalObservations; i++) {
                const lng = bbox[0] + Math.random() * (bbox[2] - bbox[0]);
                const lat = bbox[1] + Math.random() * (bbox[3] - bbox[1]);
                
                const point = [lng, lat];
                // Only add points that fall within the actual boundary
                if (turf.booleanPointInPolygon(point, feature)) {
                    points.push({
                        coordinates: point,
                        date: new Date(this.startDate.getTime() + 
                            Math.random() * (this.endDate.getTime() - this.startDate.getTime()))
                    });
                }
            }

            // Sort by date
            this.observations = points.sort((a, b) => a.date - b.date);
            
            console.log(`Generated ${this.observations.length} valid observations`);
        },

        animate() {
            if (!this.isPlaying) return;

            // Update pest spread
            const totalDuration = this.endDate - this.startDate;
            this.pestProgress = (this.currentDate - this.startDate) / totalDuration;
            this.updateDisplay();

            // Advance time by one day
            this.currentDate = new Date(this.currentDate.getTime() + 24 * 60 * 60 * 1000);

            if (this.currentDate <= this.endDate) {
                requestAnimationFrame(this.animate);
            } else {
                this.isPlaying = false;
            }
        },

        updateDisplay() {
            // Update pest spread area
            const bbox = turf.bbox(this.boundary);
            const spreadLng = bbox[0] + (bbox[2] - bbox[0]) * this.pestProgress;
            
            this.map.getSource('pest-spread').setData({
                type: 'Feature',
                geometry: {
                    type: 'Polygon',
                    coordinates: [[
                        [bbox[0], bbox[1]],
                        [spreadLng, bbox[1]],
                        [spreadLng, bbox[3]],
                        [bbox[0], bbox[3]],
                        [bbox[0], bbox[1]]
                    ]]
                }
            });

            // Show observations for current day
            const currentObs = this.observations.filter(obs => 
                obs.date.toDateString() === this.currentDate.toDateString()
            );

            this.map.getSource('observations').setData({
                type: 'FeatureCollection',
                features: currentObs.map(obs => ({
                    type: 'Feature',
                    geometry: {
                        type: 'Point',
                        coordinates: obs.coordinates
                    }
                }))
            });

            // Check for new detections
            const newDetections = currentObs.filter(obs => {
                const isPestPresent = obs.coordinates[0] <= spreadLng;
                const isDetected = isPestPresent && Math.random() * 100 <= this.detectionRate;
                if (isDetected) {
                    // Store detection in accumulated set using stringified coordinates as key
                    this.accumulatedDetections.add(JSON.stringify(obs.coordinates));
                }
                return isDetected;
            });

            // Show all accumulated detections
            this.map.getSource('detections').setData({
                type: 'FeatureCollection',
                features: Array.from(this.accumulatedDetections).map(coordStr => ({
                    type: 'Feature',
                    geometry: {
                        type: 'Point',
                        coordinates: JSON.parse(coordStr)
                    }
                }))
            });

            // Optional: Log detection statistics
            if (newDetections.length > 0) {
                console.log(`Day ${this.currentDate.toLocaleDateString()}: ${newDetections.length} new detections, ${this.accumulatedDetections.size} total`);
            }
        }
    }
}).mount('#app') 