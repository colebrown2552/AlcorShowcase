// Detail page for a single mental-health disorder, with linked treatments and locations.
import '../../../assets/css/style.css';
import '../../../assets/css/base.css';
import 'bootstrap/dist/css/bootstrap.css';
import { useParams, Link } from 'react-router-dom';
import React from 'react';
import {
  Chart as ChartJS,
  ArcElement,
  Tooltip, 
  Legend
} from 'chart.js';

import { Pie } from 'react-chartjs-2';

ChartJS.register(
  ArcElement, 
  Tooltip, 
  Legend
);

/**
 * Detail page for one disorder.
 * @param {{disorderData: object[], locationData: object[], treatmentData: object[]}} props data from the API.
 * @returns {JSX.Element} the page.
 */
export function DisorderInfoTile(props) {
  function getLocationId(name) {
    var data = props.locationData;
    for (var i = 0; i < data.length; i++) {
      if (name === data[i].name) {
        return data[i].id;
      }
    }
    return -1;
  }
  
  function getTreatmentId(name) {
    var data = props.treatmentData;

    for (var i = 0; i < data.length; i++) {
      if (name === data[i].title) {
        return data[i].id;
      }
    }
  }

  function getDisorderIndex(id) {
    var data = props.disorderData;

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
    id = getDisorderIndex(id);
  }

  console.log("Disorder data" + props.disorderData.length);

  const [pieprops, setPieProps] = React.useState({
    labels: [props.disorderData.length > 0 ?  props.disorderData[id].name : '', 'Rest of population'],
    datasets: [
      {
        data: [props.disorderData.length > 0 ?  props.disorderData[id].population_affected : 100, 
          props.disorderData.length > 0 ?  100-props.disorderData[id].population_affected : 100],
        backgroundColor: ['aqua', 'grey']
      }
    ]
  }, [props.disorderData]); 
  
  const options = {
    responsive: false
  };

  return (
    <div class="mt-3 container">
        { props.disorderData.length > 0 &&
            <div class="card info vw-25">
                <img src={props.disorderData[id].image_url} alt="" />
                <div class="card-body">
                    <h5 class="card-title">{props.disorderData[id].name}</h5>
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
                                {props.disorderData[id].description}
                            </div>
                        </div>
                    </div>
                </div>
                <div class="accordion" id="accordionCauses">
                    <div class="accordion-item">
                        <h2 class="accordion-header">
                            <button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#collapseTwo" aria-expanded="false" aria-controls="collapseOne">
                                Causes
                            </button>
                        </h2>
                        <div id="collapseTwo" class="accordion-collapse collapse" data-bs-parent="#accordionCauses">
                            <div class="accordion-body">
                                {props.disorderData[id].causes}
                            </div>
                        </div>
                    </div>
                </div>
                <div class="accordion" id="accordionDiagnosis">
                    <div class="accordion-item">
                        <h2 class="accordion-header">
                            <button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#collapseThree" aria-expanded="false" aria-controls="collapseOne">
                                Diagnosis
                            </button>
                        </h2>
                        <div id="collapseThree" class="accordion-collapse collapse" data-bs-parent="#accordionExample">
                            <div class="accordion-body">
                                {props.disorderData[id].diagnosis}
                            </div>
                        </div>
                    </div>
                </div>
                <div class="accordion" id="accordionSymptoms">
                    <div class="accordion-item">
                        <h2 class="accordion-header">
                            <button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#collapseFour" aria-expanded="false" aria-controls="collapseOne">
                                Symptoms
                            </button>
                        </h2>
                        <div id="collapseFour" class="accordion-collapse collapse" data-bs-parent="#accordionSymptoms">
                            <div class="accordion-body">
                                {props.disorderData[id].symptoms}
                            </div>
                        </div>
                    </div>
                </div>
                <div class="accordion" id="accordionTreatments">
                    <div class="accordion-item">
                        <h2 class="accordion-header">
                            <button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#collapseFive" aria-expanded="false" aria-controls="collapseOne">
                                Possible Treatments
                            </button>
                        </h2>
                        <div id="collapseFive" class="accordion-collapse collapse" data-bs-parent="#accordionTreatments">
                            <div class="accordion-body">
                                <li className="list-group-item">
                                    <ul>
                                    {props.disorderData[id].treatments_list.map((element, index) => (
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
                <div class="accordion" id="accordionLocations">
                    <div class="accordion-item">
                        <h2 class="accordion-header">
                            <button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#collapseSix" aria-expanded="false" aria-controls="collapseOne">
                                Possible Locations
                            </button>
                        </h2>
                        <div id="collapseSix" class="accordion-collapse collapse" data-bs-parent="#accordionLocations">
                            <div class="accordion-body">
                                <li className="list-group-item">
                                    <ul>
                                    {props.disorderData[id].locations_list.map((element, index) => 
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
                <ul class="list-group list-group-flush">
                    <li class="list-group-item">
                    Disorder Percentages and Statistics:
                    <Pie data={pieprops}
                        options={options}>
                    </Pie> 
                    </li>
                </ul>
            </div>}
    </div>
  );
}  
