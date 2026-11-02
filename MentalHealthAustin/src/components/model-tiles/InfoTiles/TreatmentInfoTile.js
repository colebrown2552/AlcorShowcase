// Detail page for a single treatment, with linked disorders and locations.
import '../../../assets/css/style.css';
import '../../../assets/css/base.css';
import 'bootstrap/dist/css/bootstrap.css';
import { useParams, Link } from 'react-router-dom';
import React from 'react';
/**
 * Detail page for one treatment.
 * @param {{treatmentData: object[], disorderData: object[], locationData: object[]}} props data from the API.
 * @returns {JSX.Element} the page.
 */
export function TreatmentInfoTile(props) {
  function getLocationId(name) {
    var data = props.locationData;
    for (var i = 0; i < data.length; i++) {
      if (name === data[i].name) {
        console.log(name);
        console.log(i);
        return data[i].id;
      }
    }
    return -1;
  }
  
  function getDisorderId(name) {
    var data = props.disorderData;

    for (var i = 0; i < data.length; i++) {
      if (name === data[i].name) {
        return data[i].id;
      }
    }
  }

  function getTreatmentIndex(id) {
    var data = props.treatmentData;

    for (var i = 0; i < data.length; i++) {
      if (data[i].id == id) {
        return i;
      }
    }
  }

  // Helper function to bold the text before the colon
  const boldBeforeColon = (text) => {
    return <span style={{ fontWeight: 600 }}>{text}</span>;
  };

  var { id } = useParams();
  if (!id){
    id = 0;
  } else {
    id = getTreatmentIndex(id);
  }
  var treatability = props.treatmentData.length > 0 ? props.treatmentData[id].disorders_list.length / 20 * 100 + '%' : '100%';

  return (
    <div class="mt-3 container">
        { props.treatmentData.length > 0 &&
            <div class="card info vw-25">
                <img src={props.treatmentData[id].media} alt="" />
                <div class="card-body">
                    <h5 class="card-title">{props.treatmentData[id]?.name ? props.treatmentData[id].name.toLowerCase().split(" ").map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ") : ''}</h5>
                </div>
                <div class="accordion" id="accordionDescription">
                    <div class="accordion-item">
                        <h2 class="accordion-header">
                            <button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#collapseOne" aria-expanded="false" aria-controls="collapseOne">
                                Description
                            </button>
                        </h2>
                        <div id="collapseOne" class="accordion-collapse collapse" data-bs-parent="#accordionDescription">
                            <div class="accordion-body">
                                {props.treatmentData[id].description}
                            </div>
                        </div>
                    </div>
                </div>
            <ul class="list-group list-group-flush">
                <li class="list-group-item">{boldBeforeColon("Title:")} {props.treatmentData[id].title.toLowerCase().split(" ").map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ")}</li>
                <li class="list-group-item">{boldBeforeColon("URL:")} <a href={props.treatmentData[id].url} isExternal={true} target="_blank" class="card-link">{props.treatmentData[id].url}</a></li>
                <li class="list-group-item">{boldBeforeColon("Treatment Type:")} {props.treatmentData[id].treatment_type}</li>
                <li class="list-group-item">
                {boldBeforeColon("Percent of Disorders Treated:")}
                <div class="progress" role="progressbar" aria-label="Basic example" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100">
                    <div class="progress-bar" style={{width: treatability}}></div>
                    &nbsp; Treats {treatability} of mental disorders
                </div>
                </li>
                <div class="accordion" id="accordionDisorders">
                    <div class="accordion-item">
                        <h2 class="accordion-header">
                            <button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#collapseTwo" aria-expanded="false" aria-controls="collapseTwo">
                                Disorders Served
                            </button>
                        </h2>
                        <div id="collapseTwo" class="accordion-collapse collapse" data-bs-parent="#accordionDisorders">
                            <div class="accordion-body">
                                <li className="list-group-item">
                                    <ul>
                                    {props.treatmentData[id].disorders_list.map((element, index) => (
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
                <div class="accordion" id="accordionLocations">
                    <div class="accordion-item">
                        <h2 class="accordion-header">
                            <button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#collapseThree" aria-expanded="false" aria-controls="collapseThree">
                                Locations to Obtain Treatment
                            </button>
                        </h2>
                        <div id="collapseThree" class="accordion-collapse collapse" data-bs-parent="#accordionLocations">
                            <div class="accordion-body">
                                <li className="list-group-item">
                                    <ul>
                                    {props.treatmentData[id].locations_list.map((element, index) => 
                                    getLocationId(element) > 0 && (
                                        <li key={index}>
                                        <Link to={"/locations/" + getLocationId(element)} className="card-link">{element}</Link>
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