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
            invasionDirection: 'west', // Add this new property
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
            const bbox = turf.bbox(this.boundary);
            const minX = bbox[0],
                  minY = bbox[1],
                  maxX = bbox[2],
                  maxY = bbox[3];
            let pestPolygon;
          
            switch (this.invasionDirection) {
              case 'west': {
                const spreadLng = minX + (maxX - minX) * this.pestProgress;
                pestPolygon = [[
                  [minX, minY],
                  [spreadLng, minY],
                  [spreadLng, maxY],
                  [minX, maxY],
                  [minX, minY]
                ]];
                break;
              }
              case 'east': {
                const spreadLng = maxX - (maxX - minX) * this.pestProgress;
                pestPolygon = [[
                  [maxX, minY],
                  [spreadLng, minY],
                  [spreadLng, maxY],
                  [maxX, maxY],
                  [maxX, minY]
                ]];
                break;
              }
              case 'north': {
                const spreadLat = maxY - (maxY - minY) * this.pestProgress;
                pestPolygon = [[
                  [minX, maxY],
                  [maxX, maxY],
                  [maxX, spreadLat],
                  [minX, spreadLat],
                  [minX, maxY]
                ]];
                break;
              }
              case 'south': {
                const spreadLat = minY + (maxY - minY) * this.pestProgress;
                pestPolygon = [[
                  [minX, minY],
                  [maxX, minY],
                  [maxX, spreadLat],
                  [minX, spreadLat],
                  [minX, minY]
                ]];
                break;
              }
              case 'northeast': {
                // Anchor: top-right [maxX, maxY]
                // Lower-left point moves from [maxX, maxY] to [minX, minY] as progress goes from 0 to 1.
                const lowerLeft = [
                  maxX - (maxX - minX) * this.pestProgress,
                  maxY - (maxY - minY) * this.pestProgress
                ];
                // Build rectangle using standard (clockwise) order: bottom-left, bottom-right, top-right, top-left.
                pestPolygon = [[
                  lowerLeft,
                  [maxX, lowerLeft[1]],
                  [maxX, maxY],
                  [lowerLeft[0], maxY],
                  lowerLeft
                ]];
                break;
              }
              case 'northwest': {
                // Anchor: top-left [minX, maxY]
                // Lower-right point moves from [minX, maxY] to [maxX, minY]
                const lowerRight = [
                  minX + (maxX - minX) * this.pestProgress,
                  maxY - (maxY - minY) * this.pestProgress
                ];
                // Build rectangle from bottom-left to top-right:
                pestPolygon = [[
                  [minX, lowerRight[1]],
                  lowerRight,
                  [lowerRight[0], maxY],
                  [minX, maxY],
                  [minX, lowerRight[1]]
                ]];
                break;
              }
              case 'southeast': {
                // Anchor: bottom-right [maxX, minY]
                // Upper-left point moves from [maxX, minY] to [minX, maxY]
                const upperLeft = [
                  maxX - (maxX - minX) * this.pestProgress,
                  minY + (maxY - minY) * this.pestProgress
                ];
                pestPolygon = [[
                  [upperLeft[0], minY],
                  [maxX, minY],
                  [maxX, upperLeft[1]],
                  [upperLeft[0], upperLeft[1]],
                  [upperLeft[0], minY]
                ]];
                break;
              }
              case 'southwest': {
                // Anchor: bottom-left [minX, minY]
                // Upper-right point moves from [minX, minY] to [maxX, maxY]
                const upperRight = [
                  minX + (maxX - minX) * this.pestProgress,
                  minY + (maxY - minY) * this.pestProgress
                ];
                pestPolygon = [[
                  [minX, minY],
                  [upperRight[0], minY],
                  [upperRight[0], upperRight[1]],
                  [minX, upperRight[1]],
                  [minX, minY]
                ]];
                break;
              }
            }
          
            this.map.getSource('pest-spread').setData({
              type: 'Feature',
              geometry: {
                type: 'Polygon',
                coordinates: pestPolygon
              }
            });

            // Update detection logic
            const isPestPresent = (coordinates) => {
                switch(this.invasionDirection) {
                    case 'west':
                        return coordinates[0] <= bbox[0] + (bbox[2] - bbox[0]) * this.pestProgress;
                    case 'east':
                        return coordinates[0] >= bbox[2] - (bbox[2] - bbox[0]) * this.pestProgress;
                    case 'north':
                        return coordinates[1] >= bbox[3] - (bbox[3] - bbox[1]) * this.pestProgress;
                    case 'south':
                        return coordinates[1] <= bbox[1] + (bbox[3] - bbox[1]) * this.pestProgress;
                    case 'northeast':
                        const distFromNE = Math.max(
                            (bbox[2] - coordinates[0]) / (bbox[2] - bbox[0]),
                            (bbox[3] - coordinates[1]) / (bbox[3] - bbox[1])
                        );
                        return distFromNE <= this.pestProgress;
                    case 'northwest':
                        const distFromNW = Math.max(
                            (coordinates[0] - bbox[0]) / (bbox[2] - bbox[0]),
                            (bbox[3] - coordinates[1]) / (bbox[3] - bbox[1])
                        );
                        return distFromNW <= this.pestProgress;
                    case 'southeast':
                        const distFromSE = Math.max(
                            (bbox[2] - coordinates[0]) / (bbox[2] - bbox[0]),
                            (coordinates[1] - bbox[1]) / (bbox[3] - bbox[1])
                        );
                        return distFromSE <= this.pestProgress;
                    case 'southwest':
                        const distFromSW = Math.max(
                            (coordinates[0] - bbox[0]) / (bbox[2] - bbox[0]),
                            (coordinates[1] - bbox[1]) / (bbox[3] - bbox[1])
                        );
                        return distFromSW <= this.pestProgress;
                }
            };

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
                const isDetected = isPestPresent(obs.coordinates) && Math.random() * 100 <= this.detectionRate;
                if (isDetected) {
                    this.accumulatedDetections.add(JSON.stringify(obs.coordinates));
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