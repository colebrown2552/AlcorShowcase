// Detail page for a single treatment location, including its OpenStreetMap view.
import '../../../assets/css/style.css';
import '../../../assets/css/base.css';
import 'bootstrap/dist/css/bootstrap.css';
import { useParams, Link } from 'react-router-dom';
import { LocationMap } from '../../LocationMap.js';
import { FaStar } from 'react-icons/fa';
import React from 'react';

/**
 * Detail page for one location: OpenStreetMap marker, rating, contact details, and linked disorders and treatments.
 * @param {{locationData: object[], disorderData: object[], treatmentData: object[]}} props data loaded from the API.
 */
export function LocationInfoTile(props) {
  function getDisorderId(name) {
    var data = props.disorderData;

    for (var i = 0; i < data.length; i++) {
      if (name === data[i].name) {
        return data[i].id;
      }
    }
  }
  
  function getTreatmentId(name) {
    var data = props.treatmentData;

    for (var i = 0; i < data.length; i++) {
      if (name === data[i].title) {
        return data[i].id;
      }
    }
  }

  // Helper function to bold the text before the colon
  const boldBeforeColon = (text) => {
    return <span style={{ fontWeight: 600 }}>{text}</span>;
  };

  function getLocationIndex(id) {
    var data = props.locationData;

    for (var i = 0; i < data.length; i++) {
      if (data[i].id == id) {
        return i;
      }
    }
  }

  var { id } = useParams();
  if (!id){
    id = 0;
  } else {
    id = getLocationIndex(id);
  }


  return (
    <div class="mt-3 container">
        { props.locationData.length > 0 &&
            <div class="card info vw-25">
                <LocationMap
                    latitude={props.locationData[id].latitude}
                    longitude={props.locationData[id].longitude}
                    height={350}
                    zoom={14}
                />
                <span>{[...Array(Math.round(props.locationData[id].rating))].map(star => {
                    return <FaStar color='blue' size={30}></FaStar>;
                })}</span>
                <div class="card-body">
                    <h5 class="card-title">{props.locationData[id].name}</h5>
                </div>
                <ul class="list-group list-group-flush">
                    <li class="list-group-item">{boldBeforeColon("Phone Number:")} {props.locationData[id].phone_number}</li>
                    <li class="list-group-item">{boldBeforeColon("Address:")} {props.locationData[id].address}</li>
                    <li class="list-group-item">{boldBeforeColon("Hours:")} {props.locationData[id].hours}</li>
                    <li class="list-group-item">{boldBeforeColon("Latitude:")} {props.locationData[id].latitude}</li>
                    <li class="list-group-item">{boldBeforeColon("Longitude:")} {props.locationData[id].longitude}</li>
                    <div class="accordion" id="accordionDisorders">
                        <div class="accordion-item">
                            <h2 class="accordion-header">
                                <button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#collapseOne" aria-expanded="false" aria-controls="collapseOne">
                                    Disorders Served
                                </button>
                            </h2>
                            <div id="collapseOne" class="accordion-collapse collapse" data-bs-parent="#accordionDisorders">
                                <div class="accordion-body">
                                    <li className="list-group-item">
                                        <ul>
                                        {props.locationData[id].disorders_list.map((element, index) => (
                                            <li key={index}>
                                            <Link to={"/disorders/" + getDisorderId(element)} className="card-link">{element}</Link>
                                            </li>
                                        ))}
                                        </ul>
                                    </li>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="accordion" id="accordionTreatments">
                        <div class="accordion-item">
                            <h2 class="accordion-header">
                                <button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#collapseTwo" aria-expanded="false" aria-controls="collapseOne">
                                    Possible Treatments
                                </button>
                            </h2>
                            <div id="collapseTwo" class="accordion-collapse collapse" data-bs-parent="#accordionTreatments">
                                <div class="accordion-body">
                                    <li className="list-group-item">
                                        <ul>
                                        {props.locationData[id].treatments_list.map((element, index) => (
                                            <li key={index}>
                                            <Link to={"/treatments/" + getTreatmentId(element)} className="card-link">
                                            {element.toLowerCase().split(" ").map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ")}
                                            </Link>
                                            </li>
                                        ))}
                                        </ul>
                                    </li>
                                </div>
                            </div>
                        </div>
                    </div>
                </ul>
            </div>}
    </div>
  );
}