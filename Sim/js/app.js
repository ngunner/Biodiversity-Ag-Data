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
            firstDetection: {
                date: null,
                coordinates: null
            },
            playheadPosition: 100, // 0 to 100
            isReplaying: false,
            simulationData: [], // Will store state at each timestep
            spreadRate: 100, // Added for the new pest spread calculation
            originPoint: [0, 0], // Added for the new pest spread calculation
            numberOfIterations: 1,
            currentIteration: 0,
            allRunStats: [], // Array to store stats from each run
            meanStats: {
                detectionRate: 0,
                daysToFirstDetection: 0,
                totalDetections: 0
            },
            charts: {}, // Will hold Chart.js instances
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

            // Add new layer for first detection marker
            this.map.addLayer({
                id: 'first-detection',
                type: 'circle',
                source: {
                    type: 'geojson',
                    data: {
                        type: 'FeatureCollection',
                        features: []
                    }
                },
                paint: {
                    'circle-radius': 8,
                    'circle-color': '#ff0000',
                    'circle-stroke-width': 2,
                    'circle-stroke-color': '#ffffff'
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

        async startSimulation() {
            if (!this.boundary) {
                alert('Please load a boundary file first');
                return;
            }

            this.isPlaying = true;
            this.allRunStats = [];
            this.currentIteration = 0;
            this.isLoading = true; // Show loading spinner

            try {
                // Run multiple iterations
                while (this.currentIteration < this.numberOfIterations) {
                    this.currentIteration++;
                    
                    // Reset for this iteration
                    this.currentDate = new Date(this.startDate);
                    this.pestProgress = 0;
                    this.accumulatedDetections.clear();
                    // Reset first detection data for each iteration
                    this.firstDetection = {
                        date: null,
                        coordinates: null
                    };
                    this.stats.daysToFirstDetection = null;
                    
                    // Clear first detection marker
                    if (this.map && this.map.getSource('first-detection')) {
                        this.map.getSource('first-detection').setData({
                            type: 'FeatureCollection',
                            features: []
                        });
                    }
                    
                    await new Promise(resolve => setTimeout(resolve, 0));
                    this.generateObservations();

                    // Run this iteration
                    await this.runIteration();

                    // Store stats for this iteration
                    this.allRunStats.push({
                        detectionRate: parseFloat(this.stats.detectionRate),
                        daysToFirstDetection: this.stats.daysToFirstDetection,
                        totalDetections: this.stats.totalDetections
                    });

                    // Only calculate means and update histograms if we have multiple iterations
                    if (this.numberOfIterations > 1) {
                        this.updateMeanStats();
                        if (this.currentIteration === this.numberOfIterations) {
                            this.updateHistograms();
                        }
                    }
                }
                
                // Final iteration is complete
                this.simulationComplete = true;
                this.showStats = true;
            } finally {
                this.isLoading = false; // Hide loading spinner
            }
        },

        async runIteration() {
            return new Promise(resolve => {
                // Clear previous simulation data if this is the first iteration
                if (this.currentIteration === 1) {
                    this.simulationData = [];
                }

                const animate = () => {
                    if (!this.isPlaying) return;

                    this.pestProgress = (this.currentDate - this.startDate) / (this.endDate - this.startDate);
                    this.updateDisplay();

                    // Store state for replay (only on the final iteration)
                    if (this.currentIteration === this.numberOfIterations) {
                        this.simulationData.push({
                            date: new Date(this.currentDate),
                            pestProgress: this.pestProgress,
                            observations: this.observations.filter(obs => 
                                obs.date.toDateString() === this.currentDate.toDateString()
                            ),
                            detections: Array.from(this.accumulatedDetections).map(coordStr => JSON.parse(coordStr)),
                            firstDetection: this.firstDetection ? { ...this.firstDetection } : null
                        });
                    }

                    this.currentDate = new Date(this.currentDate.getTime() + 24 * 60 * 60 * 1000);

                    if (this.currentDate <= this.endDate) {
                        requestAnimationFrame(animate);
                    } else {
                        // Reset playhead position at the end of simulation
                        if (this.currentIteration === this.numberOfIterations) {
                            this.playheadPosition = 100;
                        }
                        resolve();
                    }
                };
                animate();
            });
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
            if (!this.isPlaying || !this.boundary) return;

            // Update pest spread
            const totalDuration = this.endDate - this.startDate;
            this.pestProgress = (this.currentDate - this.startDate) / totalDuration;
            
            // Calculate current boundary state with detailed safety checks
            const boundaryState = this.boundary.features.map(feature => {
                try {
                    if (!feature.geometry?.coordinates?.[0]?.[0]) {
                        console.warn('Invalid feature geometry:', feature);
                        return feature;
                    }

                    const coordinates = feature.geometry.coordinates[0][0];
                    if (!Array.isArray(coordinates) || coordinates.length < 2) {
                        console.warn('Invalid coordinates format:', coordinates);
                        return feature;
                    }

                    if (!this.originPoint) {
                        console.warn('Origin point not set');
                        return feature;
                    }

                    const dist = this.distance(coordinates, this.originPoint);
                    const progress = Math.max(0, Math.min(1, 
                        1 - (dist / (this.spreadRate * this.pestProgress))
                    ));

                    return {
                        type: 'Feature',
                        geometry: feature.geometry,
                        properties: {
                            ...feature.properties,
                            pestProgress: progress
                        }
                    };
                } catch (error) {
                    console.error('Error processing feature:', error, feature);
                    return feature;
                }
            });

            // Update the display
            this.updateDisplay();

            // Store state for replay
            this.simulationData.push({
                date: new Date(this.currentDate),
                pestProgress: this.pestProgress,
                observations: this.observations.filter(obs => 
                    obs.date.toDateString() === this.currentDate.toDateString()
                ),
                detections: Array.from(this.accumulatedDetections).map(coordStr => JSON.parse(coordStr)),
                boundaryState: boundaryState,
                firstDetection: this.firstDetection ? { ...this.firstDetection } : null
            });

            // Update boundary visualization with safety check
            if (this.map && this.map.getSource('boundary')) {
                this.map.getSource('boundary').setData({
                    type: 'FeatureCollection',
                    features: boundaryState
                });
            }

            // Advance time by one day
            this.currentDate = new Date(this.currentDate.getTime() + 24 * 60 * 60 * 1000);

            if (this.currentDate <= this.endDate) {
                requestAnimationFrame(this.animate);
            } else {
                this.isPlaying = false;
                this.simulationComplete = true;
                this.showStats = true;
            }
        },

        updateDisplay() {
            // Skip detection logic if we're just replaying
            if (this.simulationComplete) {
                this.updatePestSpread();
                return;
            }

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
                    // Track first detection
                    if (this.stats.daysToFirstDetection === null && this.accumulatedDetections.size === 1) {
                        this.stats.daysToFirstDetection = 
                            Math.ceil((this.currentDate - this.startDate) / (1000 * 60 * 60 * 24));
                        this.firstDetection.date = new Date(this.currentDate);
                        this.firstDetection.coordinates = obs.coordinates;
                        
                        // Update first detection marker
                        this.map.getSource('first-detection').setData({
                            type: 'FeatureCollection',
                            features: [{
                                type: 'Feature',
                                geometry: {
                                    type: 'Point',
                                    coordinates: obs.coordinates
                                }
                            }]
                        });
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

        calculateFeaturePestProgress(feature) {
            return Math.max(0, Math.min(1, 
                1 - (this.distance(feature.geometry.coordinates[0][0], this.originPoint) 
                    / (this.spreadRate * this.pestProgress))
            ));
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

        handlePlayheadChange(event) {
            if (!this.simulationComplete || !this.simulationData.length || !this.map) return;
            
            this.playheadPosition = parseFloat(event.target.value);
            const index = Math.floor((this.simulationData.length - 1) * (this.playheadPosition / 100));
            const state = this.simulationData[index];
            
            this.currentDate = new Date(state.date);
            this.pestProgress = state.pestProgress;
            
            // Update accumulated detections to match the state at this point
            this.accumulatedDetections = new Set(state.detections.map(coords => JSON.stringify(coords)));
            
            // Update first detection marker based on current date
            if (this.map.getSource('first-detection')) {
                const shouldShowFirstDetection = this.firstDetection && 
                    this.firstDetection.date && 
                    this.currentDate >= this.firstDetection.date;

                this.map.getSource('first-detection').setData({
                    type: 'FeatureCollection',
                    features: shouldShowFirstDetection ? [{
                        type: 'Feature',
                        geometry: {
                            type: 'Point',
                            coordinates: this.firstDetection.coordinates
                        }
                    }] : []
                });
            }

            // Update observations
            if (this.map.getSource('observations')) {
                this.map.getSource('observations').setData({
                    type: 'FeatureCollection',
                    features: state.observations.map(obs => ({
                        type: 'Feature',
                        geometry: {
                            type: 'Point',
                            coordinates: obs.coordinates
                        }
                    }))
                });
            }

            // Update detections
            if (this.map.getSource('detections')) {
                this.map.getSource('detections').setData({
                    type: 'FeatureCollection',
                    features: state.detections.map(coords => ({
                        type: 'Feature',
                        geometry: {
                            type: 'Point',
                            coordinates: coords
                        }
                    }))
                });
            }

            // Update pest spread visualization
            this.updatePestSpread(state.pestProgress);
        },

        updatePestSpread(progress) {
          // If no progress is passed in, default to the current this.pestProgress
          if (progress === undefined) {
            progress = this.pestProgress;
          }
        
          // Safety checks
          if (!this.map || !this.map.getSource('pest-spread') || !this.boundary) return;
        
          // Get bounding box of your current boundary
          const bbox = turf.bbox(this.boundary);
          const minX = bbox[0];
          const minY = bbox[1];
          const maxX = bbox[2];
          const maxY = bbox[3];
        
          let pestPolygon;
          switch (this.invasionDirection) {
            case 'west': {
              const spreadLng = minX + (maxX - minX) * progress;
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
              const spreadLng = maxX - (maxX - minX) * progress;
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
              const spreadLat = maxY - (maxY - minY) * progress;
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
              const spreadLat = minY + (maxY - minY) * progress;
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
              const lowerLeft = [
                maxX - (maxX - minX) * progress,
                maxY - (maxY - minY) * progress
              ];
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
              const lowerRight = [
                minX + (maxX - minX) * progress,
                maxY - (maxY - minY) * progress
              ];
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
              const upperLeft = [
                maxX - (maxX - minX) * progress,
                minY + (maxY - minY) * progress
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
              const upperRight = [
                minX + (maxX - minX) * progress,
                minY + (maxY - minY) * progress
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
        
          // Update the pest-spread layer with a polygon geometry
          this.map.getSource('pest-spread').setData({
            type: 'Feature',
            geometry: {
              type: 'Polygon',
              coordinates: pestPolygon
            }
          });
        },

        replaySimulation() {
            if (!this.simulationComplete || !this.simulationData.length) return;
            
            this.isReplaying = true;
            // Calculate starting frame based on current playhead position
            let frame = Math.floor((this.simulationData.length - 1) * (this.playheadPosition / 100));
            
            const animate = () => {
                if (!this.isReplaying) return;
                
                this.playheadPosition = (frame / (this.simulationData.length - 1)) * 100;
                this.handlePlayheadChange({ target: { value: this.playheadPosition } });
                
                frame++;
                if (frame < this.simulationData.length) {
                    setTimeout(() => requestAnimationFrame(animate), 50); // Control replay speed
                } else {
                    this.isReplaying = false;
                }
            };
            
            animate();
        },

        stopReplay() {
            this.isReplaying = false;
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

            this.firstDetection = {
                date: null,
                coordinates: null
            };
            
            // Reset first detection marker
            this.map.getSource('first-detection').setData({
                type: 'FeatureCollection',
                features: []
            });

            this.playheadPosition = 100;
            this.isReplaying = false;
            this.simulationData = [];
        },

        // Helper function to calculate distance between two points
        distance(point1, point2) {
            // Add safety checks for the distance calculation
            if (!point1 || !point2) {
                console.warn('Invalid points for distance calculation:', { point1, point2 });
                return 0;
            }
            const [x1, y1] = point1;
            const [x2, y2] = point2;
            if (typeof x1 !== 'number' || typeof y1 !== 'number' || 
                typeof x2 !== 'number' || typeof y2 !== 'number') {
                console.warn('Invalid coordinates:', { point1, point2 });
                return 0;
            }
            return Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
        },

        updateMeanStats() {
            const stats = this.allRunStats;
            this.meanStats = {
                detectionRate: stats.reduce((sum, s) => sum + s.detectionRate, 0) / stats.length,
                daysToFirstDetection: stats.reduce((sum, s) => sum + (s.daysToFirstDetection || 0), 0) / stats.length,
                totalDetections: stats.reduce((sum, s) => sum + s.totalDetections, 0) / stats.length
            };
        },

        updateHistograms() {
            // Create histograms using Chart.js
            const createHistogram = (canvasId, data, label) => {
                const ctx = document.getElementById(canvasId);
                if (this.charts[canvasId]) {
                    this.charts[canvasId].destroy();
                }

                // Calculate histogram bins
                const values = data.filter(v => v !== null);
                const min = Math.min(...values);
                const max = Math.max(...values);

                // Calculate optimal bin width using Freedman-Diaconis rule
                const getOptimalBinCount = (data) => {
                    // Sort the data to calculate IQR
                    const sorted = [...data].sort((a, b) => a - b);
                    const q1 = sorted[Math.floor(sorted.length * 0.25)];
                    const q3 = sorted[Math.floor(sorted.length * 0.75)];
                    const iqr = q3 - q1;
                    
                    // Freedman-Diaconis rule: bin width = 2 * IQR * n^(-1/3)
                    const binWidth = 2 * iqr * Math.pow(data.length, -1/3);
                    
                    // Calculate number of bins
                    const binCount = Math.ceil((max - min) / binWidth);
                    
                    // Ensure reasonable limits (between 5 and 20 bins)
                    return Math.max(5, Math.min(20, binCount));
                };

                const binCount = getOptimalBinCount(values);
                const binWidth = (max - min) / binCount;
                const bins = Array(binCount).fill(0);
                const binLabels = Array(binCount).fill(0);

                // Create bin labels and initialize bins
                for (let i = 0; i < binCount; i++) {
                    const binStart = min + (i * binWidth);
                    const binEnd = binStart + binWidth;
                    binLabels[i] = `${binStart.toFixed(1)} - ${binEnd.toFixed(1)}`;
                }

                // Fill the bins
                values.forEach(value => {
                    if (value === max) {
                        // Handle edge case: put maximum value in last bin
                        bins[binCount - 1]++;
                    } else {
                        const binIndex = Math.floor((value - min) / binWidth);
                        bins[binIndex]++;
                    }
                });

                this.charts[canvasId] = new Chart(ctx, {
                    type: 'bar',
                    data: {
                        labels: binLabels,
                        datasets: [{
                            label: label,
                            data: bins,
                            backgroundColor: 'rgba(54, 162, 235, 0.5)'
                        }]
                    },
                    options: {
                        responsive: true,
                        scales: {
                            y: {
                                beginAtZero: true,
                                title: {
                                    display: true,
                                    text: 'Frequency'
                                }
                            },
                            x: {
                                ticks: {
                                    maxRotation: 45,
                                    minRotation: 45
                                }
                            }
                        },
                        plugins: {
                            legend: {
                                display: false
                            },
                            title: {
                                display: true,
                                text: label
                            }
                        }
                    }
                });
            };

            createHistogram('detectionRateHist', 
                this.allRunStats.map(s => s.detectionRate), 
                'Detection Rate (%)');
            createHistogram('daysToFirstDetectionHist', 
                this.allRunStats.map(s => s.daysToFirstDetection), 
                'Days to First Detection');
            createHistogram('totalDetectionsHist', 
                this.allRunStats.map(s => s.totalDetections), 
                'Total Detections');
        }
    }
}).mount('#app') 