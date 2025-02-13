const { createApp } = Vue

createApp({
    data() {
        return {
            map: null,
            boundary: null,
            isPlaying: false,
            // Simulation parameters
            observationDensity: 1,    // observations per 100km² per month
            detectionRate: 20,        // % chance of detecting pest if present
            startDate: new Date('2025-05-01'),
            endDate: new Date('2025-09-31'),
            currentDate: new Date('2025-05-01'),
            // Simulation state
            observations: [],
            detections: [],
            pestProgress: 0,  // 0 to 1, representing spread from west to east
            accumulatedDetections: new Set(), // Add this to store all successful detections
            isLoading: false, // Add this new property
            stats: {
                totalObservations: 0,
                totalDetections: 0,
                detectionRate: 0,
                pestArea: 0,
                coveragePercent: 0,
                daysToFirstDetection: null,
                avgDetectionsPerDay: 0,
                detectionsByWeek: []
            },
            showStats: false,  // Controls statistics panel visibility
            simulationComplete: false,  // Add this new property
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
                    'circle-radius': 4,
                    'circle-color': '#ff0000',
                    'circle-stroke-width': 0,
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
                // const points = turf.explode(feature);
                // const hull = turf.convex(points);
                
                // Or use simplification with tolerance
                const simplified = turf.simplify(feature, {
                    tolerance: 0.01,
                    highQuality: true
                });

                // Create new FeatureCollection with simplified geometry
                this.boundary = {
                    type: 'FeatureCollection',
                    features: [simplified] // or [simplified] if using simplification
                };

                // Update map
                this.map.getSource('boundary').setData(this.boundary);
                
                // Fit map to boundary
                const bbox = turf.bbox(this.boundary);
                this.map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 50 });

                console.log('Original vertices:', turf.explode(feature).features.length);
                console.log('Simplified vertices:', turf.explode(simplified).features.length);
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
            this.accumulatedDetections.clear();
            this.simulationComplete = false;
            this.showStats = false;
            
            // Show loading spinner
            this.isLoading = true;
            
            setTimeout(() => {
                this.generateObservations();
                this.isLoading = false;
                this.animate();
            }, 0);
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
                this.simulationComplete = true;
                this.showStats = true;  // Automatically show stats when simulation ends
            }
        },

        updateStats() {
            const bbox = turf.bbox(this.boundary);
            const totalArea = turf.area(this.boundary) / 1000000; // km²
            const spreadLng = bbox[0] + (bbox[2] - bbox[0]) * this.pestProgress;
            
            // Calculate pest-affected area
            const pestPolygon = turf.polygon([[
                [bbox[0], bbox[1]],
                [spreadLng, bbox[1]],
                [spreadLng, bbox[3]],
                [bbox[0], bbox[3]],
                [bbox[0], bbox[1]]
            ]]);
            const pestArea = turf.area(pestPolygon) / 1000000; // km²

            // Count observations in pest-affected area
            const observationsInPestArea = this.observations.filter(obs => 
                obs.date <= this.currentDate && 
                obs.coordinates[0] <= spreadLng
            ).length;

            // Count successful detections
            const successfulDetections = this.accumulatedDetections.size;

            // Update statistics
            this.stats = {
                totalObservations: this.observations.length,
                totalDetections: successfulDetections,
                detectionRate: observationsInPestArea > 0 ? 
                    ((successfulDetections / observationsInPestArea) * 100).toFixed(1) : '0.0',
                pestArea: Math.round(pestArea),
                coveragePercent: ((successfulDetections / Math.max(1, pestArea)) * 100).toFixed(1),
                daysToFirstDetection: this.stats.daysToFirstDetection,
                avgDetectionsPerDay: (successfulDetections / 
                    Math.max(1, Math.ceil((this.currentDate - this.startDate) / (1000 * 60 * 60 * 24)))).toFixed(1)
            };
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
                    this.accumulatedDetections.add(JSON.stringify(obs.coordinates));
                    // Record first detection
                    if (this.stats.daysToFirstDetection === null) {
                        this.stats.daysToFirstDetection = 
                            Math.ceil((this.currentDate - this.startDate) / (1000 * 60 * 60 * 24));
                    }
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

            // Update statistics
            this.updateStats();
        },

        resetSimulation() {
            // Stop animation if running
            this.isPlaying = false;
            
            // Reset date
            this.currentDate = new Date(this.startDate);
            
            // Reset progress and stats
            this.pestProgress = 0;
            this.accumulatedDetections.clear();
            this.simulationComplete = false;
            this.showStats = false;
            
            // Reset observations array
            this.observations = [];
            
            // Reset map sources
            this.map.getSource('pest-spread').setData({
                type: 'Feature',
                geometry: {
                    type: 'Polygon',
                    coordinates: []
                }
            });
            
            this.map.getSource('observations').setData({
                type: 'FeatureCollection',
                features: []
            });
            
            this.map.getSource('detections').setData({
                type: 'FeatureCollection',
                features: []
            });
            
            // Reset statistics
            this.stats = {
                totalObservations: 0,
                totalDetections: 0,
                detectionRate: 0,
                pestArea: 0,
                coveragePercent: 0,
                daysToFirstDetection: null,
                avgDetectionsPerDay: 0,
                detectionsByWeek: []
            };
        }
    }
}).mount('#app') 