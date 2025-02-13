const { createApp } = Vue

createApp({
    data() {
        return {
            map: null,
            startDate: new Date('2025-05-01'),
            endDate: new Date('2025-10-01'),
            startDateInput: '2025-05-01',
            endDateInput: '2025-10-01',
            currentTime: new Date('2025-05-01').getTime(),
            isPlaying: false,
            animationFrame: null,
            observationDensity: 1,
            taxonomicalLikelihood: 50,
            observationPoints: [],
            currentPoints: [],
            detectedPoints: new Set(),
            allDetections: new Map(),
            simulationComplete: false,
            totalObservationCount: 0,
            processedPoints: new Set(),
            customBoundary: null,
            isComputing: false,
            simulationResults: null,
            computationProgress: 0,
            bounds: {
                minLng: -79.76195572267673,
                maxLng: -71.66878968312145,
                minLat: 40.476578082629224,
                maxLat: 45.015870524557556
            },
            updateTimeout: null,
            isDragging: false,
            isPrecompiling: false,
            precompileProgress: 0,
            hasPrecompiledResults: false,
            startTime: 0,
            defaultBoundaryLoaded: false,
            uploadInstructions: 'Choose a GeoJSON file to define a custom boundary area (optional - defaults to NY state)',
            isGeneratingPoints: false,
            pointGenerationProgress: 0,
            simulationData: null,
            simulationProgress: 0,
            simulationStatus: '',
            totalObservations: 0,
            totalDetections: 0
        }
    },
    computed: {
        detectionRate() {
            if (this.totalObservationCount === 0) return 0;
            return ((this.detectedPoints.size / this.totalObservationCount) * 100).toFixed(1);
        },
        getPlayButtonText() {
            if (this.isGeneratingPoints) return 'Generating Points...';
            if (this.isPrecompiling) return 'Preparing Simulation...';
            if (this.isPlaying) return 'Pause';
            return 'Play';
        }
    },
    mounted: async function() {
        try {
            this.map = new maplibregl.Map({
                container: 'map',
                style: 'https://demotiles.maplibre.org/style.json',
                center: [-75.6, 42.9],
                zoom: 6,
                maxZoom: 10,
                minZoom: 5,
                renderWorldCopies: false,
                preserveDrawingBuffer: false,
                trackResize: false
            });

            await new Promise((resolve, reject) => {
                this.map.on('load', resolve);
                this.map.on('error', reject);
            });

            // Load NY state boundary
            const response = await fetch('./data/ny_state_boundary.geojson');
            if (!response.ok) throw new Error('Failed to load default boundary');
            
            const geojsonData = await response.json();
            this.customBoundary = geojsonData;
            this.defaultBoundaryLoaded = true;

            this.initializeMapLayers();
        } catch (error) {
            console.error('Error in mounted:', error);
        }
    },
    methods: {
        initializeMapLayers() {
            // Add boundary to map
            this.map.addSource('boundary', {
                type: 'geojson',
                data: this.customBoundary
            });

            // Add pest spread source (renamed from progress-overlay)
            this.map.addSource('pest-spread', {
                type: 'geojson',
                data: this.calculateProgressPolygon(0)
            });

            // Add observation points source (renamed from observation-points)
            this.map.addSource('observations', {
                type: 'geojson',
                data: {
                    type: 'FeatureCollection',
                    features: []
                }
            });

            // Add detected points source (renamed from detected-points)
            this.map.addSource('detections', {
                type: 'geojson',
                data: {
                    type: 'FeatureCollection',
                    features: []
                }
            });

            // Update layer definitions to match new source names
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
                    'circle-color': '#666',
                    'circle-opacity': 0.7
                }
            });

            this.map.addLayer({
                id: 'detections',
                type: 'circle',
                source: 'detections',
                paint: {
                    'circle-radius': 6,
                    'circle-color': '#ff0000',
                    'circle-opacity': 0.9,
                    'circle-stroke-width': 2,
                    'circle-stroke-color': '#ffffff'
                }
            });
        },
        calculateProgressPolygon(progress) {
            if (!this.bounds) return null;
            
            // Calculate the longitude where the pest has spread to
            const spreadLng = this.bounds.minLng + ((this.bounds.maxLng - this.bounds.minLng) * progress);
            
            return {
                type: 'Feature',
                geometry: {
                    type: 'Polygon',
                    coordinates: [[
                        [this.bounds.minLng, this.bounds.minLat],
                        [spreadLng, this.bounds.minLat],
                        [spreadLng, this.bounds.maxLat],
                        [this.bounds.minLng, this.bounds.maxLat],
                        [this.bounds.minLng, this.bounds.minLat]
                    ]]
                }
            };
        },
        formatDate(date) {
            return date.toLocaleDateString();
        },
        updateProgress() {
            if (!this.map) return;
            
            // Throttle updates to every 100ms
            if (this._updateThrottle) return;
            this._updateThrottle = setTimeout(() => {
                this._updateThrottle = null;
            }, 100);
            
            const totalDuration = this.endDate.getTime() - this.startDate.getTime();
            const currentProgress = (this.currentTime - this.startDate.getTime()) / totalDuration;
            
            // Batch map source updates
            const updates = {
                progress: this.calculateProgressPolygon(currentProgress),
                currentPoints: [],
                detectedPoints: []
            };

            // Filter points more efficiently
            const timeWindow = 2 * 24 * 60 * 60 * 1000;
            const minTime = this.currentTime - timeWindow;
            const newPoints = [];
            
            // Binary search for start index
            let startIdx = this.binarySearchPoints(this.observationPoints, minTime);
            let endIdx = this.binarySearchPoints(this.observationPoints, this.currentTime);

            // Process only points within the time window
            for (let i = startIdx; i <= endIdx && i < this.observationPoints.length; i++) {
                const point = this.observationPoints[i];
                if (point.properties.timestamp <= this.currentTime && 
                    point.properties.timestamp > minTime) {
                    newPoints.push(point);
                }
            }

            // Count new points efficiently
            for (const point of newPoints) {
                if (!this.processedPoints.has(point.properties.id)) {
                    this.totalObservationCount++;
                    this.processedPoints.add(point.properties.id);
                }
            }

            // Update current points
            this.currentPoints = newPoints;

            // Batch update map sources
            if (this.map.getSource('pest-spread')) {
                this.map.getSource('pest-spread').setData(updates.progress);
            }

            const currentFeatures = {
                type: 'FeatureCollection',
                features: this.currentPoints
            };

            if (this.map.getSource('observations')) {
                this.map.getSource('observations').setData(currentFeatures);
            }

            this.checkDetections(currentProgress);
        },
        binarySearchPoints(points, timestamp) {
            let left = 0;
            let right = points.length - 1;
            
            while (left <= right) {
                const mid = Math.floor((left + right) / 2);
                const midTime = points[mid].properties.timestamp;
                
                if (midTime === timestamp) {
                    return mid;
                } else if (midTime < timestamp) {
                    left = mid + 1;
                } else {
                    right = mid - 1;
                }
            }
            
            return left;
        },
        checkDetections(progress) {
            // Check only current points that haven't been evaluated
            const newPoints = this.currentPoints.filter(point => 
                !this.allDetections.has(point.properties.id)
            );

            // Calculate the current spread longitude
            const spreadLng = this.bounds.minLng + ((this.bounds.maxLng - this.bounds.minLng) * progress);

            // Check new points for detection
            newPoints.forEach(point => {
                const isInSpreadArea = point.geometry.coordinates[0] <= spreadLng;
                const isDetected = isInSpreadArea && (Math.random() * 100 <= this.taxonomicalLikelihood);

                // Store the detection result with its timestamp
                this.allDetections.set(point.properties.id, {
                    isDetected,
                    timestamp: point.properties.timestamp
                });
            });

            // Update current detections based on time
            this.detectedPoints = new Set(
                Array.from(this.allDetections.entries())
                    .filter(([_, data]) => 
                        data.isDetected && data.timestamp <= this.currentTime
                    )
                    .map(([id, _]) => id)
            );

            // Update detected points on map
            if (this.map.getSource('detections')) {
                const detectedFeatures = this.observationPoints.filter(point => 
                    this.detectedPoints.has(point.properties.id)
                );

                this.map.getSource('detections').setData({
                    type: 'FeatureCollection',
                    features: detectedFeatures
                });
            }
        },
        toggleAnimation() {
            if (!this.customBoundary) {
                alert('Please load a boundary file first');
                return;
            }

            if (this.isPlaying) {
                this.isPlaying = false;
                return;
            }

            // Clear any existing simulation data
            this.simulationData = null;
            
            // Start new simulation
            this.runSimulation();
        },
        animate() {
            if (!this.isPlaying) return;

            const now = performance.now();
            if (!this._lastAnimationTime) {
                this._lastAnimationTime = now;
            }

            const elapsed = now - this._lastAnimationTime;
            if (elapsed > 16) { // Cap at ~60fps
                const step = 43200000; // Half day in milliseconds
                this.currentTime += step;
                this._lastAnimationTime = now;

                if (this.currentTime > this.endDate.getTime()) {
                    this.isPlaying = false;
                    this.simulationComplete = true;
                    this.currentTime = this.endDate.getTime();
                    return;
                }

                this.updateProgress();
            }
            
            this.animationFrame = requestAnimationFrame(() => this.animate());
        },
        updateDateRange() {
            const newStartDate = new Date(this.startDateInput);
            const newEndDate = new Date(this.endDateInput);
            
            // Update the dates without validation
            this.startDate = newStartDate;
            this.endDate = newEndDate;
            this.currentTime = newStartDate.getTime();
            
            // If animation is playing, stop it
            if (this.isPlaying) {
                this.toggleAnimation();
            }
            
            this.updateProgress();
        },
        updateParameters() {
            // Immediately update the UI value
            if (this.updateTimeout) {
                clearTimeout(this.updateTimeout);
            }

            // Only reset simulation after user stops dragging
            this.updateTimeout = setTimeout(() => {
                this.resetSimulation();
            }, 300); // Wait 300ms after last change before updating
        },
        handleSliderStart() {
            this.isDragging = true;
            if (this.isPlaying) {
                this.toggleAnimation(); // Pause if playing
            }
        },
        handleSliderEnd() {
            this.isDragging = false;
            this.resetSimulation();
        },
        generatePotentialPoints() {
            return new Promise((resolve) => {
                if (!this.customBoundary || !this.customBoundary.features) {
                    console.error('Invalid boundary data');
                    this.isGeneratingPoints = false;
                    resolve();
                    return;
                }

                this.isGeneratingPoints = true;
                this.pointGenerationProgress = 0;
                this.observationPoints = [];
                
                // Get bounding box
                const bbox = turf.bbox(this.customBoundary);
                const area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) * 111 * 111; // Rough km² calculation
                const monthsInSimulation = (this.endDate - this.startDate) / (1000 * 60 * 60 * 24 * 30);
                const pointCount = Math.round(area * this.observationDensity * monthsInSimulation);
                
                let validPoints = 0;
                const generateChunk = () => {
                    const chunkSize = 100;
                    let pointsInChunk = 0;

                    while (pointsInChunk < chunkSize && validPoints < pointCount) {
                        const point = [
                            bbox[0] + Math.random() * (bbox[2] - bbox[0]),
                            bbox[1] + Math.random() * (bbox[3] - bbox[1])
                        ];
                        
                        // Generate point regardless of boundary
                        const timestamp = this.startDate.getTime() + 
                            Math.random() * (this.endDate.getTime() - this.startDate.getTime());
                        
                        this.observationPoints.push({
                            type: 'Feature',
                            geometry: {
                                type: 'Point',
                                coordinates: point
                            },
                            properties: {
                                id: validPoints.toString(),
                                timestamp: timestamp,
                                inBoundary: turf.booleanPointInPolygon(point, this.customBoundary.features[0])
                            }
                        });
                        
                        validPoints++;
                        pointsInChunk++;
                    }

                    this.pointGenerationProgress = (validPoints / pointCount) * 100;

                    if (validPoints < pointCount) {
                        setTimeout(generateChunk, 0);
                    } else {
                        this.observationPoints.sort((a, b) => a.properties.timestamp - b.properties.timestamp);
                        this.isGeneratingPoints = false;
                        resolve();
                    }
                };

                generateChunk();
            });
        },
        resetSimulation(generatePoints = true) {
            if (this.isPlaying) {
                this.isPlaying = false;
                cancelAnimationFrame(this.animationFrame);
            }

            this.currentTime = this.startDate.getTime();
            this.observationPoints = [];
            this.currentPoints = [];
            this.detectedPoints = new Set();
            this.allDetections = new Map();
            this.totalObservationCount = 0;
            this.processedPoints = new Set();
            this.simulationComplete = false;

            if (this.map) {
                const progressSource = this.map.getSource('pest-spread');
                if (progressSource) {
                    progressSource.setData(this.calculateProgressPolygon(0));
                }

                const observationSource = this.map.getSource('observations');
                if (observationSource) {
                    observationSource.setData({
                        type: 'FeatureCollection',
                        features: []
                    });
                }

                const detectedSource = this.map.getSource('detections');
                if (detectedSource) {
                    detectedSource.setData({
                        type: 'FeatureCollection',
                        features: []
                    });
                }
            }

            if (generatePoints) {
                this.generatePotentialPoints();
            }
        },
        fixPolygonWinding(geojson) {
            const isClockwise = coords => {
                let sum = 0;
                for (let i = 0; i < coords.length - 1; i++) {
                    sum += (coords[i + 1][0] - coords[i][0]) * (coords[i + 1][1] + coords[i][1]);
                }
                return sum > 0;
            };

            const reverseCoords = coords => {
                if (Array.isArray(coords[0][0])) {
                    return coords.map(reverseCoords);
                }
                return coords.reverse();
            };

            geojson.features.forEach(feature => {
                if (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon') {
                    const coords = feature.geometry.coordinates;
                    if (feature.geometry.type === 'Polygon') {
                        if (isClockwise(coords[0])) {
                            feature.geometry.coordinates = reverseCoords(coords);
                        }
                    } else {
                        coords.forEach((poly, i) => {
                            if (isClockwise(poly[0])) {
                                feature.geometry.coordinates[i] = reverseCoords(poly);
                            }
                        });
                    }
                }
            });

            return geojson;
        },
        handleFileUpload(event) {
            const file = event.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = async (e) => {
                try {
                    const geojsonData = JSON.parse(e.target.result);
                    if (!geojsonData.type || !geojsonData.features) {
                        throw new Error('Invalid GeoJSON format');
                    }

                    this.customBoundary = geojsonData;
                    this.map.getSource('boundary').setData(this.customBoundary);
                    const bbox = turf.bbox(this.customBoundary);
                    this.map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 50 });
                    this.bounds = this.calculateBoundsFromGeoJSON(this.customBoundary);
                    this.resetSimulation(false);
                } catch (error) {
                    console.error('Error loading file:', error);
                    alert('Error loading boundary file: ' + error.message);
                }
            };
            reader.readAsText(file);
        },
        calculateBoundsFromGeoJSON(geojson) {
            let minLng = Infinity, maxLng = -Infinity;
            let minLat = Infinity, maxLat = -Infinity;

            const processCoords = coords => {
                if (!coords) return;
                
                if (Array.isArray(coords[0])) {
                    coords.forEach(processCoords);
                } else if (coords.length >= 2) {  // Make sure we have at least [lng, lat]
                    minLng = Math.min(minLng, coords[0]);
                    maxLng = Math.max(maxLng, coords[0]);
                    minLat = Math.min(minLat, coords[1]);
                    maxLat = Math.max(maxLat, coords[1]);
                }
            };

            try {
                if (geojson.features && Array.isArray(geojson.features)) {
                    geojson.features.forEach(feature => {
                        if (feature && feature.geometry && feature.geometry.coordinates) {
                            processCoords(feature.geometry.coordinates);
                        }
                    });
                } else if (geojson.geometry && geojson.geometry.coordinates) {
                    processCoords(geojson.geometry.coordinates);
                }

                // Check if we found any valid coordinates
                if (minLng === Infinity || maxLng === -Infinity || 
                    minLat === Infinity || maxLat === -Infinity) {
                    throw new Error('No valid coordinates found in GeoJSON');
                }

                return { minLng, maxLng, minLat, maxLat };
            } catch (error) {
                console.error('Error processing GeoJSON bounds:', error);
                // Return a default bounding box (e.g., New York State)
                return {
                    minLng: -79.762152,
                    maxLng: -71.856214,
                    minLat: 40.496103,
                    maxLat: 45.015851
                };
            }
        },
        async runSimulation() {
            try {
                this.simulationStatus = 'Initializing...';
                this.simulationProgress = 0;
                
                const area = turf.area(this.customBoundary.features[0]) / 1000000; // Convert to km²
                const monthsInSimulation = (this.endDate - this.startDate) / (1000 * 60 * 60 * 24 * 30);
                const totalObservations = Math.ceil((area / 100) * this.observationDensity * monthsInSimulation);
                
                this.simulationStatus = `Generating ${totalObservations} observations...`;
                this.simulationProgress = 10;
                
                // Generate random observations across space and time
                const observations = [];
                const batchSize = 100;
                const totalBatches = Math.ceil(totalObservations / batchSize);
                
                for (let batch = 0; batch < totalBatches; batch++) {
                    const batchObservations = await new Promise(resolve => {
                        setTimeout(() => {
                            const batchResults = [];
                            const start = batch * batchSize;
                            const end = Math.min(start + batchSize, totalObservations);
                            
                            for (let i = start; i < end; i++) {
                                let point;
                                do {
                                    point = turf.randomPosition(turf.bbox(this.customBoundary));
                                } while (!turf.booleanPointInPolygon(point, this.customBoundary.features[0]));
                                
                                batchResults.push({
                                    coordinates: point,
                                    timestamp: this.startDate.getTime() + 
                                        Math.random() * (this.endDate.getTime() - this.startDate.getTime())
                                });
                            }
                            resolve(batchResults);
                        }, 0);
                    });
                    
                    observations.push(...batchObservations);
                    this.simulationProgress = 10 + (batch / totalBatches * 40);
                }
                
                this.simulationStatus = 'Processing observations...';
                this.simulationProgress = 50;
                
                // Sort observations by timestamp
                observations.sort((a, b) => a.timestamp - b.timestamp);
                
                // Run simulation in weekly steps
                const weekInMs = 7 * 24 * 60 * 60 * 1000;
                const steps = Math.ceil((this.endDate - this.startDate) / weekInMs);
                const simulationSteps = [];
                
                for (let step = 0; step < steps; step++) {
                    const currentTime = this.startDate.getTime() + (step * weekInMs);
                    const progress = step / steps;
                    
                    const spreadLng = this.bounds.minLng + 
                        ((this.bounds.maxLng - this.bounds.minLng) * progress);
                    
                    const weeklyObs = observations.filter(obs => 
                        obs.timestamp <= currentTime && 
                        obs.timestamp > currentTime - weekInMs
                    );
                    
                    const detections = weeklyObs.filter(obs => {
                        const isPestPresent = obs.coordinates[0] <= spreadLng;
                        return isPestPresent && Math.random() * 100 <= this.taxonomicalLikelihood;
                    });
                    
                    simulationSteps.push({
                        time: currentTime,
                        observations: weeklyObs,
                        detections: detections,
                        pestSpreadLng: spreadLng
                    });
                    
                    this.simulationProgress = 50 + (step / steps * 50);
                }
                
                this.simulationStatus = 'Starting playback...';
                this.simulationProgress = 100;
                this.simulationData = simulationSteps;
                
                // Start playback after a short delay to allow UI to update
                setTimeout(() => {
                    this.isPlaying = true;
                    this.playSimulation();
                }, 100);
                
            } catch (error) {
                console.error('Simulation error:', error);
                this.simulationStatus = 'Error: ' + error.message;
                this.isPlaying = false;
            }
        },
        playSimulation() {
            if (!this.simulationData) return;
            
            let stepIndex = 0;
            const stepInterval = 200; // 5 updates per second
            
            const playStep = () => {
                if (!this.isPlaying || stepIndex >= this.simulationData.length) {
                    this.isPlaying = false;
                    return;
                }
                
                const step = this.simulationData[stepIndex];
                this.currentTime = step.time;
                
                // Update map
                this.updateMapDisplay(step);
                
                stepIndex++;
                setTimeout(playStep, stepInterval);
            };
            
            this.isPlaying = true;
            playStep();
        },
        updateMapDisplay(step) {
            // Update pest spread area
            this.map.getSource('pest-spread').setData({
                type: 'Feature',
                geometry: {
                    type: 'Polygon',
                    coordinates: [[
                        [this.bounds.minLng, this.bounds.minLat],
                        [step.pestSpreadLng, this.bounds.minLat],
                        [step.pestSpreadLng, this.bounds.maxLat],
                        [this.bounds.minLng, this.bounds.maxLat],
                        [this.bounds.minLng, this.bounds.minLat]
                    ]]
                }
            });
            
            // Update observation points
            this.map.getSource('observations').setData({
                type: 'FeatureCollection',
                features: step.observations.map(obs => ({
                    type: 'Feature',
                    geometry: {
                        type: 'Point',
                        coordinates: obs.coordinates
                    }
                }))
            });
            
            // Update detections
            this.map.getSource('detections').setData({
                type: 'FeatureCollection',
                features: step.detections.map(obs => ({
                    type: 'Feature',
                    geometry: {
                        type: 'Point',
                        coordinates: obs.coordinates
                    }
                }))
            });
        }
    }
}).mount('#app')
