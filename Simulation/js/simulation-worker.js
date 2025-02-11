console.log('Worker script loaded');

self.onerror = function(error) {
    console.error('Worker global error:', error);
};

let config = null;

console.log('Worker variables initialized');

self.onmessage = function(e) {
    console.log('Worker received message:', e.data.type);
    
    try {
        if (e.data.type === 'init') {
            config = e.data.config;
            console.log('Worker initialized with config:', config);
            // Start processing immediately with points from config
            processSimulation(config.observationPoints);
        }
    } catch (error) {
        console.error('Worker message error:', error);
        self.postMessage({
            type: 'error',
            error: error.toString()
        });
    }
};

function processSimulation(points) {
    console.log('Starting simulation processing');
    try {
        const { startDate, endDate, bounds, taxonomicalLikelihood } = config;
        const stepSize = 43200000; // Half day in milliseconds
        const totalSteps = Math.ceil((endDate - startDate) / stepSize);
        
        console.log(`Processing ${totalSteps} steps`);
        
        let currentTime = startDate;
        let results = [];
        let allDetections = new Map();

        points.sort((a, b) => a.timestamp - b.timestamp);
        console.log('Points sorted');

        for (let step = 0; step < totalSteps; step++) {
            // Send progress updates more frequently (every 20 steps)
            if (step % 20 === 0) {
                self.postMessage({
                    type: 'progress',
                    progress: (step / totalSteps) * 100
                });
            }

            const progress = step / totalSteps;
            const currentPoints = points.filter(point => 
                point.timestamp <= currentTime &&
                point.timestamp > currentTime - (2 * 24 * 60 * 60 * 1000)
            );

            const spreadLng = bounds.minLng + ((bounds.maxLng - bounds.minLng) * progress);
            
            currentPoints.forEach(point => {
                if (!allDetections.has(point.id)) {
                    const isInSpreadArea = point.lng <= spreadLng;
                    const isDetected = isInSpreadArea && (Math.random() * 100 <= taxonomicalLikelihood);
                    allDetections.set(point.id, { isDetected, timestamp: point.timestamp });
                }
            });

            const detectedPoints = points.filter(point => 
                allDetections.has(point.id) &&
                allDetections.get(point.id).isDetected &&
                point.timestamp <= currentTime
            );

            // Convert points to GeoJSON format
            results.push({
                timestamp: currentTime,
                currentPoints: currentPoints.map(point => ({
                    type: 'Feature',
                    geometry: {
                        type: 'Point',
                        coordinates: [point.lng, point.lat]
                    },
                    properties: {
                        id: point.id,
                        timestamp: point.timestamp
                    }
                })),
                detectedPoints: detectedPoints.map(point => ({
                    type: 'Feature',
                    geometry: {
                        type: 'Point',
                        coordinates: [point.lng, point.lat]
                    },
                    properties: {
                        id: point.id,
                        timestamp: point.timestamp
                    }
                }))
            });

            currentTime += stepSize;
        }

        // Send final progress update
        self.postMessage({
            type: 'progress',
            progress: 100
        });

        console.log('Simulation complete, sending results');
        self.postMessage({
            type: 'complete',
            results: results
        });

    } catch (error) {
        console.error('Simulation processing error:', error);
        self.postMessage({
            type: 'error',
            error: error.toString()
        });
    }
} 