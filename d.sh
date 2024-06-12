#!/bin/bash

docker kill $(docker ps -q)
sleep 1
docker rm $(docker ps -a -q)
sleep 1
docker build --tag 'waste_collection' ~/dev/fly/waste-collection
sleep 1
docker run -p 3004:3004 -d 'waste_collection'

# Get the latest container ID
containerId=$(docker ps -a | tail -1 | cut -d ' ' -f1)

# Live tail the logs for the container
docker logs -f $containerId